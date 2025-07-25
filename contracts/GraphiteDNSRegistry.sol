// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

interface IReverseRegistrar {
    function setNameForAddr(address addr, string memory name) external;
    function clearNameForAddr(address addr) external;
}

interface IGraphiteResolver {
    function setOwner(bytes32 node, address owner) external;
    function owner(bytes32 node) external view returns (address);
}

/**
 * @title GraphiteDNSRegistry
 * @dev Core registry contract for Graphite DNS system with comprehensive security and ENS-inspired architecture
 */
contract GraphiteDNSRegistry is 
    ERC721,
    ERC721Enumerable,
    AccessControl,
    Pausable,
    ReentrancyGuard,
    EIP712,
    UUPSUpgradeable
{
    using ECDSA for bytes32;

    // Roles
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // Constants
    bytes32 public immutable TLD_NODE;
    uint256 public constant MAX_NAME_LENGTH = 63;
    uint256 public constant MIN_NAME_LENGTH = 1;
    uint256 public constant MAX_REGISTRATION_DURATION = 10 * 365 days;
    uint256 public constant MIN_REGISTRATION_DURATION = 28 days;
    uint256 public constant GRACE_PERIOD = 90 days;
    
    // Pricing
    uint256 public baseFee = 0.01 ether;
    uint256 public renewalFee = 0.005 ether;
    mapping(uint256 => uint256) public lengthPremium; // length -> additional fee
    
    // State
    uint256 private _nextTokenId = 1;
    mapping(bytes32 => Record) private _records;
    mapping(bytes32 => string) private _names;
    mapping(string => bytes32) private _nodes;
    mapping(bytes32 => uint256) private _tokenIds;
    mapping(uint256 => bytes32) private _nodesByTokenId;
    
    // Pricing overrides
    mapping(bytes32 => uint256) private _customPrices;
    mapping(bytes32 => bool) private _priceOverrideEnabled;
    
    // External contracts
    IReverseRegistrar public reverseRegistrar;
    address public defaultResolver;
    
    struct Record {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
        bool exists;
    }

    // EIP-712 for meta transactions
    bytes32 private constant _TRANSFER_TYPEHASH =
        keccak256("Transfer(bytes32 node,address from,address to,uint256 nonce,uint256 deadline)");
    bytes32 private constant _RENEW_TYPEHASH =
        keccak256("Renew(bytes32 node,uint64 duration,uint256 nonce,uint256 deadline)");
    
    mapping(address => uint256) private _nonces;

    // Events
    event DomainRegistered(bytes32 indexed node, string name, address indexed owner, uint64 expiry, uint256 cost);
    event DomainRenewed(bytes32 indexed node, uint64 newExpiry, uint256 cost);
    event DomainTransferred(bytes32 indexed node, address indexed from, address indexed to);
    event ResolverChanged(bytes32 indexed node, address resolver);
    event NameChanged(bytes32 indexed node, string name);
    event CustomPriceSet(bytes32 indexed node, uint256 price);
    event ReverseRegistrarSet(address reverseRegistrar);
    event DefaultResolverSet(address resolver);

    constructor(
        address _defaultResolver,
        string memory _tldName
    ) 
        ERC721("Graphite DNS", "GDNS") 
        EIP712("GraphiteDNSRegistry", "1")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRAR_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
        _grantRole(UPGRADER_ROLE, msg.sender);

        defaultResolver = _defaultResolver;
        
        // Create TLD node
        TLD_NODE = _makeNode(bytes32(0), _tldName);
        
        // Register TLD to contract
        _registerDomain(TLD_NODE, _tldName, msg.sender, uint64(block.timestamp + MAX_REGISTRATION_DURATION), _defaultResolver, bytes32(0));
        
        // Set length premiums (shorter names cost more)
        lengthPremium[1] = 1 ether;
        lengthPremium[2] = 0.5 ether;
        lengthPremium[3] = 0.1 ether;
        lengthPremium[4] = 0.05 ether;
    }

    // Modifiers
    modifier onlyNodeOwner(bytes32 node) {
        require(_records[node].owner == msg.sender, "Not node owner");
        _;
    }

    modifier onlyNodeOwnerOrApproved(bytes32 node) {
        address owner = _records[node].owner;
        require(
            owner == msg.sender || 
            isApprovedForAll(owner, msg.sender) ||
            getApproved(_tokenIds[node]) == msg.sender,
            "Not authorized"
        );
        _;
    }

    modifier validName(string memory name) {
        bytes memory nameBytes = bytes(name);
        require(nameBytes.length >= MIN_NAME_LENGTH && nameBytes.length <= MAX_NAME_LENGTH, "Invalid name length");
        require(_isValidName(name), "Invalid name format");
        _;
    }

    modifier notExpired(bytes32 node) {
        require(block.timestamp <= _records[node].expiry, "Domain expired");
        _;
    }

    modifier validDuration(uint64 duration) {
        require(duration >= MIN_REGISTRATION_DURATION && duration <= MAX_REGISTRATION_DURATION, "Invalid duration");
        _;
    }

    // Core Functions
    function register(
        string calldata name,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    ) 
        external 
        payable 
        onlyRole(REGISTRAR_ROLE) 
        whenNotPaused 
        nonReentrant 
        validName(name)
        validDuration(duration)
        returns (bytes32) 
    {
        bytes32 node = _makeNode(parent, name);
        require(_isAvailable(node), "Name not available");
        
        if (parent != bytes32(0)) {
            require(_records[parent].exists, "Parent does not exist");
            require(block.timestamp <= _records[parent].expiry, "Parent expired");
        }

        uint256 cost = _calculateCost(name, duration, parent == TLD_NODE);
        require(msg.value >= cost, "Insufficient payment");
        
        // Refund excess
        if (msg.value > cost) {
            payable(msg.sender).transfer(msg.value - cost);
        }

        uint64 expiry = uint64(block.timestamp + duration);
        _registerDomain(node, name, owner, expiry, resolver, parent);
        
        emit DomainRegistered(node, name, owner, expiry, cost);
        return node;
    }

    function renew(bytes32 node, uint64 duration) 
        external 
        payable 
        whenNotPaused 
        nonReentrant 
        validDuration(duration)
    {
        require(_records[node].exists, "Domain does not exist");
        require(
            _records[node].owner == msg.sender || 
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "Not authorized to renew"
        );

        string memory name = _names[node];
        uint256 cost = _calculateRenewalCost(name, duration);
        require(msg.value >= cost, "Insufficient payment");

        // Refund excess
        if (msg.value > cost) {
            payable(msg.sender).transfer(msg.value - cost);
        }

        uint64 newExpiry;
        if (block.timestamp <= _records[node].expiry) {
            // Renewing before expiry
            newExpiry = _records[node].expiry + duration;
        } else {
            // Renewing after expiry (grace period)
            require(block.timestamp <= _records[node].expiry + GRACE_PERIOD, "Grace period expired");
            newExpiry = uint64(block.timestamp + duration);
        }

        _records[node].expiry = newExpiry;
        emit DomainRenewed(node, newExpiry, cost);
    }

    function setResolver(bytes32 node, address resolver) 
        external 
        onlyNodeOwnerOrApproved(node) 
        notExpired(node) 
        whenNotPaused 
    {
        _records[node].resolver = resolver;
        
        // Update resolver's owner record
        if (resolver != address(0)) {
            try IGraphiteResolver(resolver).setOwner(node, _records[node].owner) {} catch {}
        }
        
        emit ResolverChanged(node, resolver);
    }

    function setCustomPrice(bytes32 node, uint256 price) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        _customPrices[node] = price;
        _priceOverrideEnabled[node] = true;
        emit CustomPriceSet(node, price);
    }

    function disableCustomPrice(bytes32 node) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        _priceOverrideEnabled[node] = false;
    }

    // Transfer functions with meta-transaction support
    function transferWithSig(
        bytes32 node,
        address from,
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        require(block.timestamp <= deadline, "Signature expired");
        require(nonce == _nonces[from], "Invalid nonce");

        bytes32 structHash = keccak256(abi.encode(_TRANSFER_TYPEHASH, node, from, to, nonce, deadline));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, signature);
        require(signer == from, "Invalid signature");

        _nonces[from]++;
        _transferNode(node, from, to);
    }

    function renewWithSig(
        bytes32 node,
        uint64 duration,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external payable whenNotPaused nonReentrant validDuration(duration) {
        require(block.timestamp <= deadline, "Signature expired");
        
        address owner = _records[node].owner;
        require(nonce == _nonces[owner], "Invalid nonce");

        bytes32 structHash = keccak256(abi.encode(_RENEW_TYPEHASH, node, duration, nonce, deadline));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, signature);
        require(signer == owner, "Invalid signature");

        _nonces[owner]++;
        
        // Execute renewal
        string memory name = _names[node];
        uint256 cost = _calculateRenewalCost(name, duration);
        require(msg.value >= cost, "Insufficient payment");

        if (msg.value > cost) {
            payable(msg.sender).transfer(msg.value - cost);
        }

        uint64 newExpiry = _records[node].expiry + duration;
        _records[node].expiry = newExpiry;
        emit DomainRenewed(node, newExpiry, cost);
    }

    // Internal functions
    function _registerDomain(
        bytes32 node,
        string memory name,
        address owner,
        uint64 expiry,
        address resolver,
        bytes32 parent
    ) internal {
        _records[node] = Record({
            owner: owner,
            resolver: resolver != address(0) ? resolver : defaultResolver,
            expiry: expiry,
            parent: parent,
            exists: true
        });

        _names[node] = name;
        _nodes[name] = node;
        
        uint256 tokenId = _nextTokenId++;
        _tokenIds[node] = tokenId;
        _nodesByTokenId[tokenId] = node;
        
        _safeMint(owner, tokenId);

        // Set reverse record for TLD domains
        if (parent == TLD_NODE && address(reverseRegistrar) != address(0)) {
            string memory fullName = string.concat(name, ".atgraphite");
            try reverseRegistrar.setNameForAddr(owner, fullName) {} catch {}
        }

        // Update resolver
        if (_records[node].resolver != address(0)) {
            try IGraphiteResolver(_records[node].resolver).setOwner(node, owner) {} catch {}
        }
    }

    function _transferNode(bytes32 node, address from, address to) internal {
        require(_records[node].owner == from, "Not owner");
        require(to != address(0), "Transfer to zero address");
        require(block.timestamp <= _records[node].expiry, "Domain expired");

        _records[node].owner = to;
        
        uint256 tokenId = _tokenIds[node];
        _transfer(from, to, tokenId);

        // Update reverse records
        if (_records[node].parent == TLD_NODE && address(reverseRegistrar) != address(0)) {
            try reverseRegistrar.clearNameForAddr(from) {} catch {}
            string memory fullName = string.concat(_names[node], ".atgraphite");
            try reverseRegistrar.setNameForAddr(to, fullName) {} catch {}
        }

        // Update resolver
        if (_records[node].resolver != address(0)) {
            try IGraphiteResolver(_records[node].resolver).setOwner(node, to) {} catch {}
        }

        emit DomainTransferred(node, from, to);
    }

    function _calculateCost(string memory name, uint64 duration, bool isTLD) internal view returns (uint256) {
        bytes32 node = _makeNode(isTLD ? TLD_NODE : bytes32(0), name);
        
        if (_priceOverrideEnabled[node]) {
            return _customPrices[node];
        }

        uint256 nameLength = bytes(name).length;
        uint256 cost = baseFee;
        
        // Add length premium
        if (lengthPremium[nameLength] > 0) {
            cost += lengthPremium[nameLength];
        }
        
        // Scale by duration (in days)
        uint256 durationInDays = (duration + 1 days - 1) / 1 days; // Round up
        cost = cost * durationInDays / 365; // Scale to yearly cost
        
        return cost;
    }

    function _calculateRenewalCost(string memory name, uint64 duration) internal view returns (uint256) {
        uint256 nameLength = bytes(name).length;
        uint256 cost = renewalFee;
        
        // Add length premium for renewals (reduced rate)
        if (lengthPremium[nameLength] > 0) {
            cost += lengthPremium[nameLength] / 2;
        }
        
        // Scale by duration
        uint256 durationInDays = (duration + 1 days - 1) / 1 days;
        cost = cost * durationInDays / 365;
        
        return cost;
    }

    function _makeNode(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function _isAvailable(bytes32 node) internal view returns (bool) {
        return !_records[node].exists || 
               (block.timestamp > _records[node].expiry + GRACE_PERIOD);
    }

    function _isValidName(string memory name) internal pure returns (bool) {
        bytes memory nameBytes = bytes(name);
        
        for (uint256 i = 0; i < nameBytes.length; i++) {
            bytes1 char = nameBytes[i];
            
            // Allow a-z, 0-9, and hyphens (but not at start/end)
            if (!(
                (char >= 0x30 && char <= 0x39) || // 0-9
                (char >= 0x61 && char <= 0x7A) || // a-z
                (char == 0x2D && i > 0 && i < nameBytes.length - 1) // hyphen not at start/end
            )) {
                return false;
            }
        }
        
        return true;
    }

    // View functions
    function getRecord(bytes32 node) external view returns (Record memory) {
        return _records[node];
    }

    function nodeOwner(bytes32 node) external view returns (address) {
        return _records[node].owner;
    }

    function nodeResolver(bytes32 node) external view returns (address) {
        return _records[node].resolver;
    }

    function nodeExpiry(bytes32 node) external view returns (uint64) {
        return _records[node].expiry;
    }

    function nodeExists(bytes32 node) external view returns (bool) {
        return _records[node].exists;
    }

    function nodeName(bytes32 node) external view returns (string memory) {
        return _names[node];
    }

    function nameNode(string calldata name) external view returns (bytes32) {
        return _nodes[name];
    }

    function isAvailable(bytes32 node) external view returns (bool) {
        return _isAvailable(node);
    }

    function priceOf(string calldata name) external view returns (uint256) {
        return _calculateCost(name, 365 days, true);
    }

    function renewalPriceOf(string calldata name, uint64 duration) external view returns (uint256) {
        return _calculateRenewalCost(name, duration);
    }

    function nonces(address owner) external view returns (uint256) {
        return _nonces[owner];
    }

    // Admin functions
    function setReverseRegistrar(address _reverseRegistrar) external onlyRole(DEFAULT_ADMIN_ROLE) {
        reverseRegistrar = IReverseRegistrar(_reverseRegistrar);
        emit ReverseRegistrarSet(_reverseRegistrar);
    }

    function setDefaultResolver(address _defaultResolver) external onlyRole(DEFAULT_ADMIN_ROLE) {
        defaultResolver = _defaultResolver;
        emit DefaultResolverSet(_defaultResolver);
    }

    function setBaseFee(uint256 _baseFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseFee = _baseFee;
    }

    function setRenewalFee(uint256 _renewalFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        renewalFee = _renewalFee;
    }

    function setLengthPremium(uint256 length, uint256 premium) external onlyRole(DEFAULT_ADMIN_ROLE) {
        lengthPremium[length] = premium;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function withdraw() external onlyRole(DEFAULT_ADMIN_ROLE) {
        payable(msg.sender).transfer(address(this).balance);
    }

    // Upgrade functionality
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}

    // ERC721 overrides
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override(ERC721, ERC721Enumerable) {
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
        
        // Update node ownership if this is a transfer (not mint/burn)
        if (from != address(0) && to != address(0)) {
            bytes32 node = _nodesByTokenId[tokenId];
            if (node != bytes32(0)) {
                _transferNode(node, from, to);
            }
        }
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        bytes32 node = _nodesByTokenId[tokenId];
        require(node != bytes32(0), "Token does not exist");
        
        // Return resolver's tokenURI if available
        address resolver = _records[node].resolver;
        if (resolver != address(0)) {
            try IGraphiteResolver(resolver).owner(node) returns (address) {
                // Resolver exists, could implement tokenURI there
                return string.concat("https://dns.atgraphite.com/token/", _names[node]);
            } catch {
                return string.concat("https://dns.atgraphite.com/token/", _names[node]);
            }
        }
        
        return string.concat("https://dns.atgraphite.com/token/", _names[node]);
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract GraphiteDNSRegistry is
    ERC721,
    AccessControl,
    Pausable,
    ReentrancyGuard,
    EIP712
{
    using ECDSA for bytes32;

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    bytes32 public immutable TLD_NODE;
    uint256 public nextId = 1;
    uint256 public gracePeriod = 90 days;
    uint256 public maxRegistration = 10 * 365 days;
    uint256 public baseFee = 0.01 ether;
    uint256 public constant MAX_NAME_LENGTH = 32;

    struct Domain {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
    }

    // Core mappings
    mapping(bytes32 => Domain) internal _domains;
    mapping(bytes32 => string) internal _labels;
    mapping(string => bytes32) internal _nodeOfLabel;
    mapping(bytes32 => uint256) private _fixedPrice;
    
    // NEW: NFT tokenId to node mapping
    mapping(uint256 => bytes32) private _tokenToNode;
    mapping(bytes32 => uint256) private _nodeToToken;
    
    // NEW: Duration-based pricing tiers
    mapping(uint256 => uint256) public durationMultipliers; // duration in years => multiplier (basis points)

    bytes32 private constant _TRANSFER_TYPEHASH =
        keccak256(
            "Transfer(bytes32 node,address from,address to,uint256 nonce,uint256 deadline)"
        );

    event DomainRegistered(
        bytes32 indexed node,
        string label,
        address owner,
        uint64 expiry
    );
    event ResolverUpdated(bytes32 indexed node, address resolver);
    event NamePurchased(
        bytes32 indexed node,
        address indexed buyer,
        uint256 cost
    );
    event DomainTransferred(
        bytes32 indexed node,
        address indexed from,
        address indexed to
    );

    constructor(address defaultResolver) ERC721("Graphite DNS", "GDNS") EIP712("GraphiteDNS", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRAR_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(RESOLVER_ROLE, msg.sender);

        TLD_NODE = keccak256(abi.encodePacked(bytes32(0), keccak256("atgraphite")));
        
        // Initialize duration multipliers (10000 = 100%, no discount/premium)
        durationMultipliers[1] = 10000;  // 1 year: base price
        durationMultipliers[2] = 9500;   // 2 years: 5% discount  
        durationMultipliers[3] = 9000;   // 3 years: 10% discount
        durationMultipliers[5] = 8500;   // 5 years: 15% discount
        durationMultipliers[10] = 8000;  // 10 years: 20% discount

        // Bootstrap .atgraphite TLD with max uint64 expiry
        _domains[TLD_NODE] = Domain(
            address(this),
            defaultResolver,
            type(uint64).max, // Use uint64 max, not uint256 max
            bytes32(0)
        );
        _labels[TLD_NODE] = "atgraphite";
    }

    // ===== PRICING FUNCTIONS =====
    
    /// @notice Set duration-based pricing multiplier
    function setDurationMultiplier(uint256 durationYears, uint256 multiplier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(multiplier > 0 && multiplier <= 20000, "Invalid multiplier"); // max 200%
        durationMultipliers[durationYears] = multiplier;
    }

    /// @notice Calculate price including duration
    function priceOf(string calldata label, uint64 duration) public view returns (uint256) {
        bytes32 node = _makeNode(TLD_NODE, label);
        uint256 basePrice = _fixedPrice[node];
        
        if (basePrice == 0) {
            uint256 len = bytes(label).length;
            basePrice = baseFee * (MAX_NAME_LENGTH - len + 1);
        }
        
        return _applyDurationPricing(basePrice, duration);
    }

    /// @notice Legacy priceOf for 1-year duration (backward compatibility)
    function priceOf(string calldata label) public view returns (uint256) {
        return priceOf(label, uint64(365 days));
    }

    function _applyDurationPricing(uint256 basePrice, uint64 duration) internal view returns (uint256) {
        uint256 durationYears = duration / 365 days;
        if (durationYears == 0) durationYears = 1; // Minimum 1 year pricing
        
        uint256 multiplier = durationMultipliers[durationYears];
        if (multiplier == 0) {
            // No specific multiplier, use linear pricing for year
            multiplier = 10000;
        }
        
        // Calculate: basePrice * years * multiplier / 10000
        return (basePrice * durationYears * multiplier) / 10000;
    }

    // ===== DOMAIN MANAGEMENT =====

    function _makeNode(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function _validateLabel(string memory label) internal pure {
        bytes memory b = bytes(label);
        require(b.length > 0 && b.length <= MAX_NAME_LENGTH, "Invalid length");
        
        for (uint i = 0; i < b.length; i++) {
            bytes1 char = b[i];
            require(
                (char >= 0x30 && char <= 0x39) || // 0-9
                (char >= 0x61 && char <= 0x7A) || // a-z
                char == 0x2D, // hyphen
                "Invalid character"
            );
        }
        
        require(b[0] != 0x2D && b[b.length - 1] != 0x2D, "Cannot start/end with hyphen");
    }

    function isAvailable(bytes32 node) public view returns (bool) {
        Domain storage domain = _domains[node];
        return domain.expiry == 0 || 
               (domain.expiry < block.timestamp && 
                block.timestamp > domain.expiry + gracePeriod);
    }

    function getDomain(bytes32 node) external view returns (Domain memory) {
        return _domains[node];
    }

    function getNodeOfLabel(string calldata label) external view returns (bytes32) {
        return _nodeOfLabel[label];
    }

    function getLabelOfNode(bytes32 node) external view returns (string memory) {
        return _labels[node];
    }

    // ===== REGISTRATION FUNCTIONS =====

    /// @notice Register domain with duration-based pricing
    function register(
        string calldata label,
        address owner_,
        uint64 duration,
        address resolver_,
        bytes32 parent
    )
        external
        payable
        onlyRole(REGISTRAR_ROLE)
        whenNotPaused
        nonReentrant
        returns (bytes32)
    {
        _validateLabel(label);
        bytes32 node = _makeNode(parent, label);
        return _registerDomain(node, label, owner_, duration, resolver_, parent);
    }

    /// @notice Buy a TLD name with duration-based pricing
    function buyFixedPrice(
        string calldata label,
        address resolver_,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        _validateLabel(label);
        bytes32 node = _makeNode(TLD_NODE, label);
        require(isAvailable(node), "Domain not available");

        uint256 cost = priceOf(label, duration);
        require(msg.value >= cost, "Insufficient payment");

        // Refund overpayment
        if (msg.value > cost) {
            payable(msg.sender).transfer(msg.value - cost);
        }

        bytes32 created = _registerDomain(
            node,
            label,
            msg.sender,
            duration,
            resolver_,
            TLD_NODE
        );
        
        emit NamePurchased(node, msg.sender, cost);
        return created;
    }

    function _registerDomain(
        bytes32 node,
        string memory label,
        address owner_,
        uint64 duration,
        address resolver_,
        bytes32 parent
    ) internal returns (bytes32) {
        require(isAvailable(node), "Domain not available");
        require(duration <= maxRegistration, "Duration too long");

        uint64 expiry = uint64(block.timestamp + duration);
        _domains[node] = Domain(owner_, resolver_, expiry, parent);
        _labels[node] = label;
        _nodeOfLabel[label] = node;

        // Mint NFT and link to node
        uint256 tokenId = nextId++;
        _tokenToNode[tokenId] = node;
        _nodeToToken[node] = tokenId;
        _safeMint(owner_, tokenId);

        emit DomainRegistered(node, label, owner_, expiry);
        if (resolver_ != address(0)) {
            emit ResolverUpdated(node, resolver_);
        }
        return node;
    }

    // ===== TRANSFER FUNCTIONS =====

    /// @notice Override ERC721 transfer to update domain ownership
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        address previousOwner = super._update(to, tokenId, auth);
        
        if (from != address(0) && to != address(0)) {
            // Update domain ownership when NFT is transferred
            bytes32 node = _tokenToNode[tokenId];
            if (node != bytes32(0)) {
                _domains[node].owner = to;
                emit DomainTransferred(node, from, to);
            }
        }
        
        return previousOwner;
    }

    /// @notice Get node associated with tokenId
    function getNodeOfToken(uint256 tokenId) external view returns (bytes32) {
        return _tokenToNode[tokenId];
    }

    /// @notice Get tokenId associated with node
    function getTokenOfNode(bytes32 node) external view returns (uint256) {
        return _nodeToToken[node];
    }

    /// @notice Meta-transfer with EIP-712 signature
    function transferWithSig(
        bytes32 node,
        address from,
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external whenNotPaused nonReentrant {
        require(block.timestamp <= deadline, "Signature expired");

        bytes32 structHash = keccak256(
            abi.encode(_TRANSFER_TYPEHASH, node, from, to, nonce, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        require(digest.recover(sig) == from, "Invalid signature");

        Domain storage domain = _domains[node];
        require(domain.owner == from, "Not domain owner");
        require(domain.expiry > block.timestamp, "Domain expired");

        // Transfer NFT
        uint256 tokenId = _nodeToToken[node];
        require(tokenId != 0, "No token for domain");
        
        _transfer(from, to, tokenId);
        // Domain ownership updated in _beforeTokenTransfer
    }

    // ===== RESOLVER FUNCTIONS =====

    function setResolver(bytes32 node, address resolver_) external {
        Domain storage domain = _domains[node];
        require(
            domain.owner == msg.sender || hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "Not authorized"
        );
        
        domain.resolver = resolver_;
        emit ResolverUpdated(node, resolver_);
    }

    // ===== ADMIN FUNCTIONS =====

    function setFixedPrice(
        string calldata label,
        uint256 price
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 node = _makeNode(TLD_NODE, label);
        _fixedPrice[node] = price;
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

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
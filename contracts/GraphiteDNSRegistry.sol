// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./interfaces/IReverseRegistrar.sol";

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

    bytes32 public immutable TLD_NODE;
    uint256 public nextId = 1;
    uint256 public gracePeriod = 90 days;
    uint256 public maxRegistration = 10 * 365 days;
    uint256 public baseFee = 0.01 ether;
    uint256 public constant MAX_NAME_LENGTH = 32;
    
    // Nonces for meta-transactions
    mapping(address => uint256) public nonces;

    struct Domain {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
    }

    mapping(bytes32 => Domain) internal _domains;
    mapping(bytes32 => string) internal _labels;
    mapping(string => bytes32) internal _nodeOfLabel;
    mapping(bytes32 => uint256) private _fixedPrice;
    mapping(uint256 => bytes32) private _tokenToNode;
    mapping(bytes32 => uint256) private _nodeToToken;

    IReverseRegistrar public reverseRegistrar;

    bytes32 private constant _TRANSFER_TYPEHASH =
        keccak256(
            "Transfer(bytes32 node,address from,address to,uint256 nonce,uint256 deadline)"
        );

    event DomainRegistered(
        bytes32 indexed node,
        string label,
        address indexed owner,
        uint64 expiry,
        bytes32 indexed parent
    );
    event DomainRenewed(
        bytes32 indexed node,
        uint64 newExpiry
    );
    event ResolverUpdated(
        bytes32 indexed node,
        address indexed resolver
    );
    event NamePurchased(
        bytes32 indexed node,
        address indexed buyer,
        uint256 cost
    );
    event FixedPriceSet(
        bytes32 indexed node,
        uint256 price
    );
    event ReverseRegistrarUpdated(
        address indexed reverseRegistrar
    );

    modifier onlyTokenOwner(bytes32 node) {
        require(_isValidOwner(node, msg.sender), "Not owner or expired");
        _;
    }

    modifier onlyTokenOwnerOrApproved(bytes32 node) {
        require(_isValidOwnerOrApproved(node, msg.sender), "Not owner/approved or expired");
        _;
    }

    constructor(
        address defaultResolver
    ) ERC721("Graphite DNS", "GDNS") EIP712("GraphiteDNSRegistry", "1") {
        TLD_NODE = keccak256(abi.encodePacked(bytes32(0), keccak256(bytes("atgraphite"))));
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRAR_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);

        // Bootstrap .atgraphite TLD
        _domains[TLD_NODE] = Domain({
            owner: msg.sender,
            resolver: defaultResolver,
            expiry: type(uint64).max,
            parent: bytes32(0)
        });
        _labels[TLD_NODE] = "atgraphite";
        _nodeOfLabel["atgraphite"] = TLD_NODE;
        
        uint256 tokenId = nextId++;
        _tokenToNode[tokenId] = TLD_NODE;
        _nodeToToken[TLD_NODE] = tokenId;
        _mint(msg.sender, tokenId);
        
        emit DomainRegistered(TLD_NODE, "atgraphite", msg.sender, type(uint64).max, bytes32(0));
    }

    // ============ View Functions ============

    function getDomain(bytes32 node) external view returns (Domain memory) {
        return _domains[node];
    }

    function getLabel(bytes32 node) external view returns (string memory) {
        return _labels[node];
    }

    function nodeOfLabel(string calldata label) external view returns (bytes32) {
        return _nodeOfLabel[label];
    }

    function tokenToNode(uint256 tokenId) external view returns (bytes32) {
        return _tokenToNode[tokenId];
    }

    function nodeToToken(bytes32 node) external view returns (uint256) {
        return _nodeToToken[node];
    }

    function isAvailable(bytes32 node) public view returns (bool) {
        Domain memory domain = _domains[node];
        return domain.owner == address(0) || 
               (domain.expiry != type(uint64).max && domain.expiry < block.timestamp);
    }

    function isExpired(bytes32 node) public view returns (bool) {
        Domain memory domain = _domains[node];
        return domain.expiry != type(uint64).max && domain.expiry < block.timestamp;
    }

    function isInGracePeriod(bytes32 node) public view returns (bool) {
        Domain memory domain = _domains[node];
        return domain.expiry != type(uint64).max && 
               domain.expiry < block.timestamp && 
               domain.expiry + gracePeriod >= block.timestamp;
    }

    function _isValidOwner(bytes32 node, address account) internal view returns (bool) {
        Domain memory domain = _domains[node];
        if (domain.owner != account) return false;
        if (domain.expiry == type(uint64).max) return true;
        return domain.expiry >= block.timestamp;
    }

    function _isValidOwnerOrApproved(bytes32 node, address account) internal view returns (bool) {
        uint256 tokenId = _nodeToToken[node];
        if (tokenId == 0) return false;
        
        Domain memory domain = _domains[node];
        if (domain.expiry != type(uint64).max && domain.expiry < block.timestamp) {
            return false; // Expired
        }
        
        return _isAuthorized(domain.owner, account, tokenId);
    }

    // ============ Registration Functions ============

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
        require(isAvailable(node), "Domain not available");

        // For subdomains, check parent is owned and not expired
        if (parent != bytes32(0)) {
            require(_isValidOwner(parent, _domains[parent].owner), "Parent not owned or expired");
        }

        return _registerDomain(node, label, owner_, duration, resolver_, parent);
    }

    function setFixedPrice(
        string calldata label,
        uint256 price
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 node = _makeNode(TLD_NODE, label);
        _fixedPrice[node] = price;
        emit FixedPriceSet(node, price);
    }

    function priceOf(string memory label) public view returns (uint256) {
        bytes32 node = _makeNode(TLD_NODE, label);
        uint256 fixedPrice = _fixedPrice[node];
        if (fixedPrice != 0) {
            return fixedPrice;
        }
        uint256 len = bytes(label).length;
        return baseFee * (MAX_NAME_LENGTH - len + 1);
    }

    function buyFixedPrice(
        string calldata label,
        address resolver_,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        _validateLabel(label);
        bytes32 node = _makeNode(TLD_NODE, label);
        require(isAvailable(node), "Domain not available");

        uint256 cost = priceOf(label);
        require(msg.value >= cost, "Insufficient payment");

        // Refund overpayment
        if (msg.value > cost) {
            payable(msg.sender).transfer(msg.value - cost);
        }

        bytes32 registered = _registerDomain(
            node,
            label,
            msg.sender,
            duration,
            resolver_,
            TLD_NODE
        );
        
        emit NamePurchased(node, msg.sender, cost);
        return registered;
    }

    function renew(bytes32 node, uint64 duration) 
        external 
        payable 
        onlyTokenOwner(node) 
        whenNotPaused 
        nonReentrant 
    {
        require(duration > 0 && duration <= maxRegistration, "Invalid duration");
        Domain storage domain = _domains[node];
        
        // Calculate cost based on duration
        string memory label = _labels[node];
        uint256 cost = _calculateRenewalCost(label, duration);
        require(msg.value >= cost, "Insufficient payment");
        
        if (msg.value > cost) {
            payable(msg.sender).transfer(msg.value - cost);
        }
        
        // Extend expiry
        if (domain.expiry == type(uint64).max) {
            // Permanent domains cannot be renewed
            revert("Permanent domain");
        }
        
        uint64 newExpiry = domain.expiry + duration;
        domain.expiry = newExpiry;
        
        emit DomainRenewed(node, newExpiry);
    }

    // ============ Ownership Functions ============

    function setResolver(bytes32 node, address resolver_) 
        external 
        onlyTokenOwnerOrApproved(node) 
        whenNotPaused 
    {
        _domains[node].resolver = resolver_;
        emit ResolverUpdated(node, resolver_);
    }

    function transferNode(bytes32 node, address to) 
        external 
        onlyTokenOwnerOrApproved(node) 
        whenNotPaused 
    {
        uint256 tokenId = _nodeToToken[node];
        require(tokenId != 0, "Invalid node");
        
        address from = _domains[node].owner;
        _domains[node].owner = to;
        
        _transfer(from, to, tokenId);
        
        // Update reverse registrar if set
        if (address(reverseRegistrar) != address(0)) {
            reverseRegistrar.updateReverse(from, to, node);
        }
    }

    function transferWithSig(
        bytes32 node,
        address from,
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused {
        require(block.timestamp <= deadline, "Signature expired");
        require(nonces[from] == nonce, "Invalid nonce");

        bytes32 structHash = keccak256(
            abi.encode(_TRANSFER_TYPEHASH, node, from, to, nonce, deadline)
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(signature);
        require(signer == from, "Invalid signature");

        nonces[from]++;
        
        require(_isValidOwnerOrApproved(node, from), "Not authorized or expired");
        
        uint256 tokenId = _nodeToToken[node];
        require(tokenId != 0, "Invalid node");
        
        _domains[node].owner = to;
        _transfer(from, to, tokenId);
        
        if (address(reverseRegistrar) != address(0)) {
            reverseRegistrar.updateReverse(from, to, node);
        }
    }

    // ============ Administrative Functions ============

    function setReverseRegistrar(address reverseRegistrar_) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        reverseRegistrar = IReverseRegistrar(reverseRegistrar_);
        emit ReverseRegistrarUpdated(reverseRegistrar_);
    }

    function setGracePeriod(uint256 gracePeriod_) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        gracePeriod = gracePeriod_;
    }

    function setBaseFee(uint256 baseFee_) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        baseFee = baseFee_;
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

    // ============ Internal Functions ============

    function _registerDomain(
        bytes32 node,
        string calldata label,
        address owner_,
        uint64 duration,
        address resolver_,
        bytes32 parent
    ) internal returns (bytes32) {
        require(duration > 0 && duration <= maxRegistration, "Invalid duration");
        require(owner_ != address(0), "Invalid owner");

        uint64 expiry;
        if (parent == bytes32(0)) {
            // TLD registration
            expiry = uint64(block.timestamp + duration);
        } else {
            // Subdomain inherits parent expiry if shorter
            Domain memory parentDomain = _domains[parent];
            uint64 maxExpiry = parentDomain.expiry;
            uint64 requestedExpiry = uint64(block.timestamp + duration);
            expiry = maxExpiry < requestedExpiry ? maxExpiry : requestedExpiry;
        }

        _domains[node] = Domain({
            owner: owner_,
            resolver: resolver_,
            expiry: expiry,
            parent: parent
        });

        _labels[node] = label;
        _nodeOfLabel[label] = node;

        uint256 tokenId = nextId++;
        _tokenToNode[tokenId] = node;
        _nodeToToken[node] = tokenId;
        _mint(owner_, tokenId);

        emit DomainRegistered(node, label, owner_, expiry, parent);
        return node;
    }

    function _makeNode(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function _validateLabel(string calldata label) internal pure {
        bytes memory labelBytes = bytes(label);
        require(labelBytes.length > 0 && labelBytes.length <= MAX_NAME_LENGTH, "Invalid label length");
        
        for (uint256 i = 0; i < labelBytes.length; i++) {
            bytes1 char = labelBytes[i];
            require(
                (char >= 0x30 && char <= 0x39) ||  // 0-9
                (char >= 0x61 && char <= 0x7A) ||  // a-z
                char == 0x2D,                       // -
                "Invalid character"
            );
            
            // Cannot start or end with hyphen
            if (i == 0 || i == labelBytes.length - 1) {
                require(char != 0x2D, "Cannot start/end with hyphen");
            }
        }
    }

    function _calculateRenewalCost(string memory label, uint64 duration) internal view returns (uint256) {
        uint256 yearlyPrice = priceOf(label);
        return (yearlyPrice * duration) / (365 days);
    }

    // ============ ERC721 Overrides ============

    function _update(address to, uint256 tokenId, address auth) 
        internal 
        override 
        returns (address) 
    {
        address from = super._update(to, tokenId, auth);
        
        // Update domain ownership
        bytes32 node = _tokenToNode[tokenId];
        if (node != bytes32(0)) {
            _domains[node].owner = to;
        }
        
        return from;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        bytes32 node = _tokenToNode[tokenId];
        Domain memory domain = _domains[node];
        
        if (domain.resolver != address(0)) {
            // Try to get metadata from resolver
            try IERC165(domain.resolver).supportsInterface(0x01ffc9a7) returns (bool) {
                // Could implement metadata resolution here
            } catch {}
        }
        
        return string(abi.encodePacked("data:application/json,{\"name\":\"", _labels[node], "\"}"));
    }

    // ============ Interface Support ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
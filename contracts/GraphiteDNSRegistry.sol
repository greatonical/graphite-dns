// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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

    mapping(bytes32 => Domain) internal _domains;
    mapping(bytes32 => string) internal _labels;
    mapping(string => bytes32) internal _nodeOfLabel;
    mapping(bytes32 => uint256) private _fixedPrice;

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
    event DomainTransferred(bytes32 indexed node, address from, address to);

    constructor(
        address resolverForTLD
    ) ERC721("Graphite DNS", "GDNS") EIP712("GraphiteDNS", "1.0.0") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRAR_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(RESOLVER_ROLE, msg.sender);

        // bootstrap the ".atgraphite" TLD
        bytes32 root = _makeNode(bytes32(0), "atgraphite");
        TLD_NODE = root;
        _registerDomain(
            root,
            "atgraphite",
            msg.sender,
            uint64(maxRegistration),
            resolverForTLD,
            bytes32(0)
        );
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _makeNode(
        bytes32 parent,
        string memory label
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function _validateLabel(string memory label) internal pure {
        bytes memory b = bytes(label);
        require(
            b.length > 0 && b.length <= MAX_NAME_LENGTH,
            "Invalid label length"
        );
    }

    function isAvailable(bytes32 node) public view returns (bool) {
        Domain storage d = _domains[node];
        return
            d.owner == address(0) || block.timestamp > d.expiry + gracePeriod;
    }

    /// @notice Read the full domain record
    function getDomain(bytes32 node) external view returns (Domain memory) {
        return _domains[node];
    }

    /// @notice Core registrar entrypoint (for registrar modules)
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
        return
            _registerDomain(node, label, owner_, duration, resolver_, parent);
    }

    /// @notice Admin sets a one-time price for a TLD name
    function setFixedPrice(
        string calldata label,
        uint256 price
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 node = _makeNode(TLD_NODE, label);
        _fixedPrice[node] = price;
    }

    /// @notice Frontend calls to display cost
    function priceOf(string calldata label) public view returns (uint256) {
        bytes32 node = _makeNode(TLD_NODE, label);
        uint256 p = _fixedPrice[node];
        if (p != 0) {
            return p;
        }
        uint256 len = bytes(label).length;
        return baseFee * (MAX_NAME_LENGTH - len + 1);
    }

    /// @notice Buy a TLD name at on-chain fixed price
    function buyFixedPrice(
        string calldata label,
        address resolver_,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        _validateLabel(label);
        bytes32 node = _makeNode(TLD_NODE, label);
        require(isAvailable(node), "Taken");

        uint256 cost = priceOf(label);
        require(msg.value >= cost, "Insufficient ETH");

        // refund any overpayment
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
        require(isAvailable(node), "Not available");
        require(duration <= maxRegistration, "Duration too long");

        uint64 expiry = uint64(block.timestamp + duration);
        _domains[node] = Domain(owner_, resolver_, expiry, parent);
        _labels[node] = label;
        _nodeOfLabel[label] = node;

        uint256 tokenId = nextId++;
        _safeMint(owner_, tokenId);

        emit DomainRegistered(node, label, owner_, expiry);
        if (resolver_ != address(0)) {
            emit ResolverUpdated(node, resolver_);
        }
        return node;
    }

    /// @notice Meta‐transfer with EIP-712 signature
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
        require(digest.recover(sig) == from, "Bad signature");

        Domain storage d = _domains[node];
        require(d.owner == from, "Not owner");
        d.owner = to;

        uint256 tokenId = uint256(node) % nextId;
        _transfer(from, to, tokenId);

        emit DomainTransferred(node, from, to);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}

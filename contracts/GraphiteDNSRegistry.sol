// contracts/GraphiteDNSRegistry.sol
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
    bytes32 public constant override DEFAULT_ADMIN_ROLE = 0x00; // from AccessControl
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    uint256 public nextId = 1;
    uint256 public gracePeriod = 90 days;
    uint256 public maxRegistration = 10 * 365 days; // 10 years
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

    // FIXED-PRICE
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
    event DomainTransferred(bytes32 indexed node, address from, address to);
    event ResolverUpdated(bytes32 indexed node, address resolver);

    constructor()
        ERC721("Graphite DNS", "GDNS")
        EIP712("GraphiteDNS", "1.0.0")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRAR_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(RESOLVER_ROLE, msg.sender);
    }

    // ─── PAUSE ───────────────────────────────────────────────────────
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ─── HELPERS ─────────────────────────────────────────────────────
    function _makeNode(
        bytes32 parent,
        string memory label
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }
    function isAvailable(bytes32 node) public view returns (bool) {
        Domain storage d = _domains[node];
        return
            d.owner == address(0) || block.timestamp > d.expiry + gracePeriod;
    }

    // ─── CORE REGISTER (onlyRole) ────────────────────────────────────
    function register(
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    )
        external
        onlyRole(REGISTRAR_ROLE)
        whenNotPaused
        nonReentrant
        returns (bytes32)
    {
        bytes32 node = _makeNode(parent, label);
        return _registerDomain(node, label, owner, duration, resolver, parent);
    }

    // ─── FIXED-PRICE API ─────────────────────────────────────────────
    /// @notice Admin sets a one-time price for a top-level name
    function setFixedPrice(
        string calldata label,
        uint256 price
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _fixedPrice[_makeNode(0, label)] = price;
    }

    /// @notice Frontend calls this to display “Cost to register”
    function priceOf(string calldata label) public view returns (uint256) {
        bytes32 node = _makeNode(0, label);
        uint256 p = _fixedPrice[node];
        if (p != 0) {
            return p;
        }
        // fallback: shorter names cost more
        uint256 len = bytes(label).length;
        return baseFee * (MAX_NAME_LENGTH - len + 1);
    }

    /// @notice Users call this to buy a top-level name at the on-chain price
    function buyFixedPrice(
        string calldata label,
        address resolver,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        bytes32 node = _makeNode(0, label);
        require(isAvailable(node), "Taken");
        uint256 cost = priceOf(label);
        require(msg.value >= cost, "Insufficient ETH");
        return _registerDomain(node, label, msg.sender, duration, resolver, 0);
    }

    // ─── INTERNAL MINT HELPER ────────────────────────────────────────
    function _registerDomain(
        bytes32 node,
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    ) internal returns (bytes32) {
        require(isAvailable(node), "Not available");
        require(duration <= maxRegistration, "Duration too long");

        _domains[node] = Domain({
            owner: owner,
            resolver: resolver,
            expiry: uint64(block.timestamp + duration),
            parent: parent
        });
        _labels[node] = label;
        _nodeOfLabel[label] = node;

        uint256 tid = nextId++;
        _safeMint(owner, tid);

        emit DomainRegistered(node, label, owner, _domains[node].expiry);
        if (resolver != address(0)) {
            emit ResolverUpdated(node, resolver);
        }
        return node;
    }

    // ─── EIP-712 TRANSFER ─────────────────────────────────────────────
    function transferWithSig(
        bytes32 node,
        address from,
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external whenNotPaused nonReentrant {
        require(block.timestamp <= deadline, "Sig expired");

        bytes32 structHash = keccak256(
            abi.encode(_TRANSFER_TYPEHASH, node, from, to, nonce, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(sig); // now visible
        require(signer == from, "Bad signature");

        Domain storage d = _domains[node];
        require(d.owner == from, "Not owner");
        d.owner = to;

        uint256 tid = uint256(node) % nextId;
        _transfer(from, to, tid);
        emit DomainTransferred(node, from, to);
    }

    // ─── SUPPORTS INTERFACE ───────────────────────────────────────────
    function supportsInterface(
        bytes4 iid
    ) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(iid);
    }
}

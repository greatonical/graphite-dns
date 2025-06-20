// contracts/GraphiteDNSRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract GraphiteDNSRegistry is ERC721, AccessControl, Pausable, ReentrancyGuard, EIP712 {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant PAUSER_ROLE    = keccak256("PAUSER_ROLE");
    bytes32 public constant RESOLVER_ROLE  = keccak256("RESOLVER_ROLE");

    uint256 public nextId = 1;
    uint256 public gracePeriod = 90 days;
    uint256 public maxRegistration = 10 * 365 days;

    struct Domain {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
    }

    mapping(bytes32 => Domain)   private _domains;
    mapping(bytes32 => string)   private _labels;
    mapping(string => bytes32)   private _nodeOfLabel;
    mapping(address => mapping(uint256 => bool)) private _usedNonces;

    bytes32 private constant _TRANSFER_TYPEHASH = 
        keccak256("Transfer(bytes32 node,address from,address to,uint256 nonce,uint256 deadline)");

    event DomainRegistered(bytes32 indexed node, string label, address owner, uint64 expiry);
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

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function _makeNode(bytes32 parent, string memory label) internal pure returns(bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function isAvailable(bytes32 node) public view returns (bool) {
        Domain storage d = _domains[node];
        return d.owner == address(0) || block.timestamp > d.expiry + gracePeriod;
    }

    function register(
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    )
        external onlyRole(REGISTRAR_ROLE) whenNotPaused nonReentrant
        returns (bytes32)
    {
        bytes32 node = _makeNode(parent, label);
        require(isAvailable(node), "Taken or in grace");
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
        if (resolver != address(0)) emit ResolverUpdated(node, resolver);
        return node;
    }

    function extend(bytes32 node, uint64 extra) external onlyRole(REGISTRAR_ROLE) {
        Domain storage d = _domains[node];
        require(block.timestamp <= d.expiry, "Expired");
        d.expiry += extra;
    }

    function reclaim(bytes32 node) external onlyRole(REGISTRAR_ROLE) {
        Domain storage d = _domains[node];
        require(block.timestamp > d.expiry + gracePeriod, "In grace");
        uint256 tid = uint256(node) % nextId;
        _burn(tid);
        delete _domains[node];
        delete _labels[node];
        delete _nodeOfLabel[_labels[node]];
    }

    function transferWithSig(
        bytes32 node,
        address from,
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sig
    ) external whenNotPaused nonReentrant {
        require(block.timestamp <= deadline, "Expired sig");
        require(!_usedNonces[from][nonce], "Nonce used");
        Domain storage d = _domains[node];
        require(d.owner == from, "Not owner");

        bytes32 structHash = keccak256(
            abi.encode(_TRANSFER_TYPEHASH, node, from, to, nonce, deadline)
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        require(hash.recover(sig) == from, "Bad sig");
        _usedNonces[from][nonce] = true;

        uint256 tid = uint256(node) % nextId;
        d.owner = to;
        _transfer(from, to, tid);
        emit DomainTransferred(node, from, to);
    }

    function setResolver(bytes32 node, address resolver)
        external onlyRole(RESOLVER_ROLE)
    {
        Domain storage d = _domains[node];
        require(block.timestamp <= d.expiry, "Expired");
        d.resolver = resolver;
        emit ResolverUpdated(node, resolver);
    }

    function supportsInterface(bytes4 iid)
        public view override(ERC721, AccessControl) returns (bool)
    {
        return super.supportsInterface(iid);
    }
}

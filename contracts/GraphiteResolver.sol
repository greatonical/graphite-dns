// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

interface IGraphiteDNSRegistry {
    struct Record {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
        bool exists;
    }
    
    function getRecord(bytes32 node) external view returns (Record memory);
    function nodeOwner(bytes32 node) external view returns (address);
}

/**
 * @title GraphiteResolver
 * @dev Enhanced resolver with comprehensive record types and proper ownership controls
 */
contract GraphiteResolver is 
    AccessControl, 
    Pausable, 
    ReentrancyGuard,
    UUPSUpgradeable,
    ERC165 
{
    IGraphiteDNSRegistry public immutable registry;
    
    // Standard record types
    mapping(bytes32 => address) private _addresses; // addr record
    mapping(bytes32 => bytes32) private _contenthash; // contenthash record
    mapping(bytes32 => string) private _names; // name record
    mapping(bytes32 => mapping(string => string)) private _texts; // text records
    mapping(bytes32 => mapping(string => bytes)) private _abis; // ABI records
    mapping(bytes32 => bytes) private _pubkeys; // Public key records
    
    // Multi-address support (coin types)
    mapping(bytes32 => mapping(uint256 => bytes)) private _addresses_by_coin_type;
    
    // Interface records
    mapping(bytes32 => mapping(bytes4 => address)) private _interfaces;
    
    // Authorization and ownership
    mapping(bytes32 => address) private _nodeOwners;
    mapping(bytes32 => mapping(address => bool)) private _operators;
    
    // Versioning for cache invalidation
    mapping(bytes32 => uint64) private _recordVersions;
    
    // Events
    event AddressChanged(bytes32 indexed node, address addr);
    event NameChanged(bytes32 indexed node, string name);
    event ContenthashChanged(bytes32 indexed node, bytes hash);
    event TextChanged(bytes32 indexed node, string indexed key, string value);
    event TextDeleted(bytes32 indexed node, string indexed key);
    event ABIChanged(bytes32 indexed node, uint256 indexed contentType);
    event PubkeyChanged(bytes32 indexed node, bytes32 x, bytes32 y);
    event AddressChangedByType(bytes32 indexed node, uint256 coinType, bytes newAddress);
    event InterfaceChanged(bytes32 indexed node, bytes4 indexed interfaceID, address implementer);
    event OperatorChanged(bytes32 indexed node, address indexed operator, bool approved);
    event OwnerChanged(bytes32 indexed node, address indexed newOwner);
    event VersionChanged(bytes32 indexed node, uint64 newVersion);

    constructor(address _registry) {
        registry = IGraphiteDNSRegistry(_registry);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    modifier onlyNodeOwnerOrOperator(bytes32 node) {
        address nodeOwner = _getNodeOwner(node);
        require(
            nodeOwner == msg.sender || 
            _operators[node][msg.sender] ||
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "Not authorized"
        );
        _;
    }

    modifier onlyValidNode(bytes32 node) {
        IGraphiteDNSRegistry.Record memory record = registry.getRecord(node);
        require(record.exists, "Node does not exist");
        require(block.timestamp <= record.expiry, "Node expired");
        _;
    }

    modifier onlyNodeOwner(bytes32 node) {
        require(_getNodeOwner(node) == msg.sender, "Not node owner");
        _;
    }

    // Ownership management
    function setOwner(bytes32 node, address newOwner) external {
        // Only registry or current owner can change ownership
        require(
            msg.sender == address(registry) || 
            _nodeOwners[node] == msg.sender ||
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "Not authorized"
        );
        
        _nodeOwners[node] = newOwner;
        _incrementVersion(node);
        emit OwnerChanged(node, newOwner);
    }

    function setOperator(bytes32 node, address operator, bool approved) 
        external 
        onlyNodeOwner(node) 
        onlyValidNode(node) 
    {
        _operators[node][operator] = approved;
        emit OperatorChanged(node, operator, approved);
    }

    // Core record types
    function setAddr(bytes32 node, address addr) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _addresses[node] = addr;
        _incrementVersion(node);
        emit AddressChanged(node, addr);
    }

    function setName(bytes32 node, string calldata name) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _names[node] = name;
        _incrementVersion(node);
        emit NameChanged(node, name);
    }

    function setContenthash(bytes32 node, bytes calldata hash) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _contenthash[node] = keccak256(hash);
        _incrementVersion(node);
        emit ContenthashChanged(node, hash);
    }

    function setText(bytes32 node, string calldata key, string calldata value) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _texts[node][key] = value;
        _incrementVersion(node);
        emit TextChanged(node, key, value);
    }

    function deleteText(bytes32 node, string calldata key) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        delete _texts[node][key];
        _incrementVersion(node);
        emit TextDeleted(node, key);
    }

    function setABI(bytes32 node, uint256 contentType, bytes calldata data) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _abis[node][string(abi.encodePacked(contentType))] = data;
        _incrementVersion(node);
        emit ABIChanged(node, contentType);
    }

    function setPubkey(bytes32 node, bytes32 x, bytes32 y) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _pubkeys[node] = abi.encodePacked(x, y);
        _incrementVersion(node);
        emit PubkeyChanged(node, x, y);
    }

    // Multi-coin address support
    function setAddrByType(bytes32 node, uint256 coinType, bytes calldata addr) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _addresses_by_coin_type[node][coinType] = addr;
        _incrementVersion(node);
        emit AddressChangedByType(node, coinType, addr);
    }

    // Interface support
    function setInterface(bytes32 node, bytes4 interfaceID, address implementer) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        _interfaces[node][interfaceID] = implementer;
        _incrementVersion(node);
        emit InterfaceChanged(node, interfaceID, implementer);
    }

    // Batch operations for efficiency
    function multicall(bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; i++) {
            (bool success, bytes memory result) = address(this).delegatecall(data[i]);
            require(success, "Multicall failed");
            results[i] = result;
        }
    }

    function setMultipleTexts(
        bytes32 node, 
        string[] calldata keys, 
        string[] calldata values
    ) 
        external 
        onlyNodeOwnerOrOperator(node) 
        onlyValidNode(node) 
        whenNotPaused 
    {
        require(keys.length == values.length, "Array length mismatch");
        
        for (uint256 i = 0; i < keys.length; i++) {
            if (bytes(values[i]).length == 0) {
                delete _texts[node][keys[i]];
                emit TextDeleted(node, keys[i]);
            } else {
                _texts[node][keys[i]] = values[i];
                emit TextChanged(node, keys[i], values[i]);
            }
        }
        _incrementVersion(node);
    }

    // Clear all records for a node
    function clearRecords(bytes32 node) 
        external 
        onlyNodeOwnerOrOperator(node) 
        whenNotPaused 
    {
        delete _addresses[node];
        delete _names[node];
        delete _contenthash[node];
        delete _pubkeys[node];
        // Note: mappings need to be cleared individually in practice
        _incrementVersion(node);
        
        emit AddressChanged(node, address(0));
        emit NameChanged(node, "");
        emit ContenthashChanged(node, "");
    }

    // View functions
    function addr(bytes32 node) external view returns (address) {
        return _addresses[node];
    }

    function name(bytes32 node) external view returns (string memory) {
        return _names[node];
    }

    function contenthash(bytes32 node) external view returns (bytes32) {
        return _contenthash[node];
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _texts[node][key];
    }

    function ABI(bytes32 node, uint256 contentType) external view returns (uint256, bytes memory) {
        bytes memory data = _abis[node][string(abi.encodePacked(contentType))];
        return (contentType, data);
    }

    function pubkey(bytes32 node) external view returns (bytes32 x, bytes32 y) {
        bytes memory data = _pubkeys[node];
        if (data.length == 64) {
            assembly {
                x := mload(add(data, 32))
                y := mload(add(data, 64))
            }
        }
    }

    function addrByType(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        return _addresses_by_coin_type[node][coinType];
    }

    function interfaceImplementer(bytes32 node, bytes4 interfaceID) external view returns (address) {
        return _interfaces[node][interfaceID];
    }

    function owner(bytes32 node) external view returns (address) {
        return _getNodeOwner(node);
    }

    function isOperator(bytes32 node, address operator) external view returns (bool) {
        return _operators[node][operator];
    }

    function recordVersions(bytes32 node) external view returns (uint64) {
        return _recordVersions[node];
    }

    // Internal functions
    function _getNodeOwner(bytes32 node) internal view returns (address) {
        address nodeOwner = _nodeOwners[node];
        if (nodeOwner == address(0)) {
            // Fallback to registry owner
            return registry.nodeOwner(node);
        }
        return nodeOwner;
    }

    function _incrementVersion(bytes32 node) internal {
        _recordVersions[node]++;
        emit VersionChanged(node, _recordVersions[node]);
    }

    // Admin functions
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // Interface support
    function supportsInterface(bytes4 interfaceId) 
        public 
        view 
        override(AccessControl, ERC165) 
        returns (bool) 
    {
        return interfaceId == type(IGraphiteDNSRegistry).interfaceId ||
               super.supportsInterface(interfaceId);
    }
}
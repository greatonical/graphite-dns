// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

interface IGraphiteDNSRegistry {
    function nodeOwner(bytes32 node) external view returns (address);
    function nodeExists(bytes32 node) external view returns (bool);
}

/**
 * @title ReverseRegistrar
 * @dev Enhanced reverse registrar with automatic management and validation
 */
contract ReverseRegistrar is 
    AccessControl, 
    Pausable, 
    ReentrancyGuard,
    UUPSUpgradeable 
{
    IGraphiteDNSRegistry public immutable registry;
    
    bytes32 public constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    
    // Address -> primary name mapping
    mapping(address => string) private _names;
    
    // Address -> all owned names (for validation)
    mapping(address => string[]) private _ownedNames;
    mapping(address => mapping(string => bool)) private _ownsName;
    
    // Name -> address mapping (for reverse lookup validation)
    mapping(string => address) private _nameToAddress;
    
    // Settings
    bool public requireOwnership = true;
    bool public autoManagement = true;
    
    event NameSet(address indexed addr, string name);
    event NameCleared(address indexed addr);
    event NameAdded(address indexed addr, string name);
    event NameRemoved(address indexed addr, string name);
    event OwnershipRequirementChanged(bool required);
    event AutoManagementChanged(bool enabled);

    constructor(address _registry) {
        registry = IGraphiteDNSRegistry(_registry);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRY_ROLE, _registry);
        _grantRole(MANAGER_ROLE, msg.sender);
    }

    modifier onlyNameOwner(string memory nameToCheck) {
        if (requireOwnership) {
            bytes32 node = _nameToNode(nameToCheck);
            require(
                registry.nodeOwner(node) == msg.sender || 
                hasRole(MANAGER_ROLE, msg.sender),
                "Not name owner"
            );
        }
        _;
    }

    modifier validName(string memory nameToCheck) {
        require(bytes(nameToCheck).length > 0, "Empty name");
        require(bytes(nameToCheck).length <= 255, "Name too long");
        _;
    }

    // Main reverse record functions
    function setName(string calldata nameToSet) 
        external 
        whenNotPaused 
        validName(nameToSet) 
        onlyNameOwner(nameToSet) 
    {
        _setNameForAddr(msg.sender, nameToSet);
    }

    function setNameForAddr(address addr, string calldata nameToSet) 
        external 
        onlyRole(REGISTRY_ROLE) 
        whenNotPaused 
        validName(nameToSet) 
    {
        _setNameForAddr(addr, nameToSet);
    }

    function clearName() external whenNotPaused {
        _clearNameForAddr(msg.sender);
    }

    function clearNameForAddr(address addr) 
        external 
        onlyRole(REGISTRY_ROLE) 
        whenNotPaused 
    {
        _clearNameForAddr(addr);
    }

    // Batch operations
    function setMultipleNames(address[] calldata addrs, string[] calldata names) 
        external 
        onlyRole(REGISTRY_ROLE) 
        whenNotPaused 
    {
        require(addrs.length == names.length, "Array length mismatch");
        
        for (uint256 i = 0; i < addrs.length; i++) {
            if (bytes(names[i]).length > 0) {
                _setNameForAddr(addrs[i], names[i]);
            } else {
                _clearNameForAddr(addrs[i]);
            }
        }
    }

    // Ownership tracking for validation
    function addOwnedName(address addr, string calldata nameToAdd) 
        external 
        onlyRole(REGISTRY_ROLE) 
        validName(nameToAdd) 
    {
        if (!_ownsName[addr][nameToAdd]) {
            _ownedNames[addr].push(nameToAdd);
            _ownsName[addr][nameToAdd] = true;
            _nameToAddress[nameToAdd] = addr;
            emit NameAdded(addr, nameToAdd);
        }
    }

    function removeOwnedName(address addr, string calldata nameToRemove) 
        external 
        onlyRole(REGISTRY_ROLE) 
    {
        if (_ownsName[addr][nameToRemove]) {
            _ownsName[addr][nameToRemove] = false;
            delete _nameToAddress[nameToRemove];
            
            // Remove from array (expensive but necessary)
            string[] storage names = _ownedNames[addr];
            for (uint256 i = 0; i < names.length; i++) {
                if (keccak256(bytes(names[i])) == keccak256(bytes(nameToRemove))) {
                    names[i] = names[names.length - 1];
                    names.pop();
                    break;
                }
            }
            
            // Clear reverse record if it was the primary name
            if (keccak256(bytes(_names[addr])) == keccak256(bytes(nameToRemove))) {
                delete _names[addr];
                emit NameCleared(addr);
            }
            
            emit NameRemoved(addr, nameToRemove);
        }
    }

    // Administrative name management
    function adminSetName(address addr, string calldata nameToSet) 
        external 
        onlyRole(MANAGER_ROLE) 
        whenNotPaused 
        validName(nameToSet) 
    {
        _setNameForAddr(addr, nameToSet);
    }

    function adminClearName(address addr) 
        external 
        onlyRole(MANAGER_ROLE) 
        whenNotPaused 
    {
        _clearNameForAddr(addr);
    }

    // Internal functions
    function _setNameForAddr(address addr, string memory nameToSet) internal {
        string memory oldName = _names[addr];
        _names[addr] = nameToSet;
        
        // Update ownership tracking if auto-management is enabled
        if (autoManagement && !_ownsName[addr][nameToSet]) {
            _ownedNames[addr].push(nameToSet);
            _ownsName[addr][nameToSet] = true;
            _nameToAddress[nameToSet] = addr;
        }
        
        emit NameSet(addr, nameToSet);
        
        // Clear old name mapping if it changed
        if (bytes(oldName).length > 0 && keccak256(bytes(oldName)) != keccak256(bytes(nameToSet))) {
            if (_nameToAddress[oldName] == addr) {
                delete _nameToAddress[oldName];
            }
        }
    }

    function _clearNameForAddr(address addr) internal {
        string memory oldName = _names[addr];
        delete _names[addr];
        
        if (bytes(oldName).length > 0) {
            if (_nameToAddress[oldName] == addr) {
                delete _nameToAddress[oldName];
            }
        }
        
        emit NameCleared(addr);
    }

    function _nameToNode(string memory nameToCheck) internal pure returns (bytes32) {
        // For full names like "alice.atgraphite", we need to compute the node
        // This is a simplified implementation - in practice, you'd parse the name
        return keccak256(bytes(nameToCheck));
    }

    // View functions
    function name(address addr) external view returns (string memory) {
        return _names[addr];
    }

    function getOwnedNames(address addr) external view returns (string[] memory) {
        return _ownedNames[addr];
    }

    function ownsName(address addr, string calldata nameToCheck) external view returns (bool) {
        return _ownsName[addr][nameToCheck];
    }

    function nameCount(address addr) external view returns (uint256) {
        return _ownedNames[addr].length;
    }

    function getNameOwner(string calldata nameToCheck) external view returns (address) {
        return _nameToAddress[nameToCheck];
    }

    function hasName(address addr) external view returns (bool) {
        return bytes(_names[addr]).length > 0;
    }

    // Validation functions
    function validateReverseClaim(address addr, string calldata claimName) 
        external 
        view 
        returns (bool valid, string memory reason) 
    {
        if (!requireOwnership) {
            return (true, "");
        }
        
        bytes32 node = _nameToNode(claimName);
        if (!registry.nodeExists(node)) {
            return (false, "Name does not exist");
        }
        
        if (registry.nodeOwner(node) != addr) {
            return (false, "Not name owner");
        }
        
        return (true, "");
    }

    // Settings
    function setOwnershipRequirement(bool required) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        requireOwnership = required;
        emit OwnershipRequirementChanged(required);
    }

    function setAutoManagement(bool enabled) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        autoManagement = enabled;
        emit AutoManagementChanged(enabled);
    }

    // Admin functions
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {}

    function supportsInterface(bytes4 interfaceId) 
        public 
        view 
        override(AccessControl) 
        returns (bool) 
    {
        return super.supportsInterface(interfaceId);
    }
}
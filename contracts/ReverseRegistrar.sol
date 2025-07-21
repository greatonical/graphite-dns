// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./GraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

interface IGraphiteDNSRegistry {
    struct Domain {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
    }
    
    function getDomain(bytes32 node) external view returns (Domain memory);
    function getNodeOfLabel(string calldata label) external view returns (bytes32);
    function TLD_NODE() external view returns (bytes32);
}

contract ReverseRegistrar is AccessControl, Pausable {
    bytes32 public constant REVERSE_ROLE = keccak256("REVERSE_ROLE");
    
    IGraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;

    // address → primary domain name
    mapping(address => string) private _primaryNames;
    
    // address → all owned domain names
    mapping(address => string[]) private _ownedNames;
    mapping(address => mapping(string => bool)) private _ownsName;

    event PrimaryNameSet(address indexed owner, string name);
    event NameAdded(address indexed owner, string name);
    event NameRemoved(address indexed owner, string name);

    constructor(address registryAddress) {
        registry = IGraphiteDNSRegistry(registryAddress);
        TLD_NODE = registry.TLD_NODE();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REVERSE_ROLE, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ===== PRIMARY NAME FUNCTIONS =====

    /// @notice Set primary name for address (must own the domain)
    function setPrimaryName(string calldata name) external whenNotPaused {
        require(bytes(name).length > 0, "Empty name");
        
        // Verify ownership of the domain
        bytes32 node = registry.getNodeOfLabel(name);
        require(node != bytes32(0), "Domain not found");
        
        IGraphiteDNSRegistry.Domain memory domain = registry.getDomain(node);
        require(domain.owner == msg.sender, "Not domain owner");
        require(domain.expiry > block.timestamp, "Domain expired");

        _primaryNames[msg.sender] = name;
        
        // Add to owned names if not already there
        if (!_ownsName[msg.sender][name]) {
            _ownedNames[msg.sender].push(name);
            _ownsName[msg.sender][name] = true;
            emit NameAdded(msg.sender, name);
        }
        
        emit PrimaryNameSet(msg.sender, name);
    }

    /// @notice Clear primary name
    function clearPrimaryName() external whenNotPaused {
        delete _primaryNames[msg.sender];
        emit PrimaryNameSet(msg.sender, "");
    }

    /// @notice Get primary name for address
    function getPrimaryName(address addr) external view returns (string memory) {
        return _primaryNames[addr];
    }

    /// @notice Legacy function name for compatibility
    function getReverse(address addr) external view returns (string memory) {
        return _primaryNames[addr];
    }

    // ===== OWNED NAMES MANAGEMENT =====

    /// @notice Add domain to owned names list (auto-called by setPrimaryName)
    function addOwnedName(string calldata name) external whenNotPaused {
        require(bytes(name).length > 0, "Empty name");
        require(!_ownsName[msg.sender][name], "Already added");
        
        // Verify ownership
        bytes32 node = registry.getNodeOfLabel(name);
        require(node != bytes32(0), "Domain not found");
        
        IGraphiteDNSRegistry.Domain memory domain = registry.getDomain(node);
        require(domain.owner == msg.sender, "Not domain owner");
        require(domain.expiry > block.timestamp, "Domain expired");

        _ownedNames[msg.sender].push(name);
        _ownsName[msg.sender][name] = true;
        
        emit NameAdded(msg.sender, name);
    }

    /// @notice Remove domain from owned names list
    function removeOwnedName(string calldata name) external whenNotPaused {
        require(_ownsName[msg.sender][name], "Name not in list");

        // Remove from array
        string[] storage names = _ownedNames[msg.sender];
        for (uint i = 0; i < names.length; i++) {
            if (keccak256(bytes(names[i])) == keccak256(bytes(name))) {
                names[i] = names[names.length - 1];
                names.pop();
                break;
            }
        }
        
        _ownsName[msg.sender][name] = false;
        
        // Clear primary name if it was the removed name
        if (keccak256(bytes(_primaryNames[msg.sender])) == keccak256(bytes(name))) {
            delete _primaryNames[msg.sender];
            emit PrimaryNameSet(msg.sender, "");
        }
        
        emit NameRemoved(msg.sender, name);
    }

    /// @notice Get all owned domain names for an address
    function getOwnedNames(address addr) external view returns (string[] memory) {
        return _ownedNames[addr];
    }

    /// @notice Get count of owned names
    function getOwnedNameCount(address addr) external view returns (uint256) {
        return _ownedNames[addr].length;
    }

    /// @notice Check if address owns a specific name in our records
    function ownsNameInReverse(address addr, string calldata name) external view returns (bool) {
        return _ownsName[addr][name];
    }

    // ===== ADMIN FUNCTIONS =====

    /// @notice Admin can set reverse name for any address
    function setReverseFor(address addr, string calldata name) 
        external 
        onlyRole(REVERSE_ROLE) 
        whenNotPaused 
    {
        if (bytes(name).length > 0) {
            // Verify the domain exists and hasn't expired
            bytes32 node = registry.getNodeOfLabel(name);
            if (node != bytes32(0)) {
                IGraphiteDNSRegistry.Domain memory domain = registry.getDomain(node);
                require(domain.expiry > block.timestamp, "Domain expired");
            }
        }
        
        _primaryNames[addr] = name;
        emit PrimaryNameSet(addr, name);
    }

    /// @notice Legacy admin function
    function setReverse(string calldata name) 
        external 
        onlyRole(REVERSE_ROLE) 
        whenNotPaused 
    {
        if (bytes(name).length > 0) {
            // Verify the domain exists and hasn't expired
            bytes32 node = registry.getNodeOfLabel(name);
            if (node != bytes32(0)) {
                IGraphiteDNSRegistry.Domain memory domain = registry.getDomain(node);
                require(domain.expiry > block.timestamp, "Domain expired");
            }
        }
        
        _primaryNames[msg.sender] = name;
        emit PrimaryNameSet(msg.sender, name);
    }

    /// @notice Sync owned names by checking registry (cleanup utility)
    function syncOwnedNames(address addr) external {
        string[] memory currentNames = _ownedNames[addr];
        
        for (uint i = 0; i < currentNames.length; i++) {
            bytes32 node = registry.getNodeOfLabel(currentNames[i]);
            if (node != bytes32(0)) {
                IGraphiteDNSRegistry.Domain memory domain = registry.getDomain(node);
                
                // Remove if no longer owned or expired
                if (domain.owner != addr || domain.expiry <= block.timestamp) {
                    // Mark for removal
                    _ownsName[addr][currentNames[i]] = false;
                    
                    // Remove from array
                    string[] storage names = _ownedNames[addr];
                    for (uint j = 0; j < names.length; j++) {
                        if (keccak256(bytes(names[j])) == keccak256(bytes(currentNames[i]))) {
                            names[j] = names[names.length - 1];
                            names.pop();
                            break;
                        }
                    }
                    
                    emit NameRemoved(addr, currentNames[i]);
                }
            }
        }
        
        // Clear primary name if it's no longer valid
        string memory primaryName = _primaryNames[addr];
        if (bytes(primaryName).length > 0 && !_ownsName[addr][primaryName]) {
            delete _primaryNames[addr];
            emit PrimaryNameSet(addr, "");
        }
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IGraphiteDNSRegistry.sol";
import "./interfaces/IReverseRegistrar.sol";

contract ReverseRegistrar is IReverseRegistrar, AccessControl, Pausable {
    
    IGraphiteDNSRegistry public immutable registry;
    
    // address => reverse name
    mapping(address => string) private _reverseNames;
    
    // address => node that set the reverse
    mapping(address => bytes32) private _reverseNodes;

    event ReverseSet(address indexed addr, string name, bytes32 indexed node);
    event ReverseCleared(address indexed addr);
    event ReverseUpdated(address indexed from, address indexed to, bytes32 indexed node);

    modifier onlyRegistry() {
        require(msg.sender == address(registry), "Only registry");
        _;
    }

    constructor(address registryAddress) {
        registry = IGraphiteDNSRegistry(registryAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============ Reverse Name Management ============

    function setReverse(string calldata name) external whenNotPaused {
        require(bytes(name).length > 0, "Empty name");
        
        // Verify the caller owns a domain that resolves to this name
        bytes32 node = _findNodeForName(name, msg.sender);
        require(node != bytes32(0), "Name not owned by caller");
        
        _reverseNames[msg.sender] = name;
        _reverseNodes[msg.sender] = node;
        
        emit ReverseSet(msg.sender, name, node);
    }

    function setReverseForNode(bytes32 node) external whenNotPaused {
        // Verify caller owns the node
        require(_isNodeOwner(node, msg.sender), "Not node owner or expired");
        
        string memory name = _buildFullName(node);
        require(bytes(name).length > 0, "Cannot resolve node to name");
        
        _reverseNames[msg.sender] = name;
        _reverseNodes[msg.sender] = node;
        
        emit ReverseSet(msg.sender, name, node);
    }

    function clearReverse() external whenNotPaused {
        delete _reverseNames[msg.sender];
        delete _reverseNodes[msg.sender];
        
        emit ReverseCleared(msg.sender);
    }

    // ============ Registry Integration ============

    function updateReverse(
        address from,
        address to,
        bytes32 node
    ) external override onlyRegistry {
        // If 'from' had reverse pointing to this node, clear it
        if (_reverseNodes[from] == node) {
            delete _reverseNames[from];
            delete _reverseNodes[from];
            emit ReverseCleared(from);
        }
        
        // Auto-set reverse for 'to' if they don't have one
        if (bytes(_reverseNames[to]).length == 0 && to != address(0)) {
            string memory name = _buildFullName(node);
            if (bytes(name).length > 0) {
                _reverseNames[to] = name;
                _reverseNodes[to] = node;
                emit ReverseSet(to, name, node);
            }
        }
        
        emit ReverseUpdated(from, to, node);
    }

    // ============ View Functions ============

    function getReverse(address addr) external view returns (string memory) {
        return _reverseNames[addr];
    }

    function getReverseNode(address addr) external view returns (bytes32) {
        return _reverseNodes[addr];
    }

    function hasValidReverse(address addr) external view returns (bool) {
        bytes32 node = _reverseNodes[addr];
        if (node == bytes32(0)) return false;
        
        // Check if the reverse is still valid (user still owns the node)
        return _isNodeOwner(node, addr);
    }

    // ============ Internal Functions ============

    function _findNodeForName(string calldata name, address owner) 
        internal 
        view 
        returns (bytes32) 
    {
        // This is a simplified implementation
        // In practice, you'd need to parse the name and walk the domain tree
        bytes32 node = keccak256(abi.encodePacked(registry.TLD_NODE(), keccak256(bytes(name))));
        
        if (_isNodeOwner(node, owner)) {
            return node;
        }
        
        return bytes32(0);
    }

    function _buildFullName(bytes32 node) internal view returns (string memory) {
        try registry.getLabel(node) returns (string memory label) {
            try registry.getDomain(node) returns (IGraphiteDNSRegistry.Domain memory domain) {
                if (domain.parent == bytes32(0)) {
                    return label;
                }
                
                string memory parentName = _buildFullName(domain.parent);
                if (bytes(parentName).length == 0) {
                    return label;
                }
                
                return string(abi.encodePacked(label, ".", parentName));
            } catch {
                return label;
            }
        } catch {
            return "";
        }
    }

    function _isNodeOwner(bytes32 node, address account) internal view returns (bool) {
        try registry.getDomain(node) returns (IGraphiteDNSRegistry.Domain memory domain) {
            if (domain.owner != account) return false;
            if (domain.expiry == type(uint64).max) return true;
            return domain.expiry >= block.timestamp;
        } catch {
            return false;
        }
    }

    // ============ Interface Support ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return
            interfaceId == type(IReverseRegistrar).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
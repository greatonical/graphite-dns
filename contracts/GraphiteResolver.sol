// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./interfaces/IGraphiteDNSRegistry.sol";

contract GraphiteResolver is AccessControl, Pausable {
    
    IGraphiteDNSRegistry public immutable registry;

    // node => (key => value)
    mapping(bytes32 => mapping(string => string)) private _textRecords;
    
    // node => address
    mapping(bytes32 => address) private _addresses;
    
    // node => (coinType => address)
    mapping(bytes32 => mapping(uint256 => bytes)) private _coinAddresses;

    event TextChanged(bytes32 indexed node, string indexed key, string value);
    event AddressChanged(bytes32 indexed node, address addr);
    event CoinAddressChanged(bytes32 indexed node, uint256 coinType, bytes addr);
    event RecordDeleted(bytes32 indexed node, string indexed key);

    modifier onlyNodeOwner(bytes32 node) {
        require(_isNodeOwner(node, msg.sender), "Not node owner or expired");
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

    // ============ Text Records ============

    function setText(
        bytes32 node,
        string calldata key,
        string calldata value
    ) external onlyNodeOwner(node) whenNotPaused {
        _textRecords[node][key] = value;
        emit TextChanged(node, key, value);
    }

    function text(bytes32 node, string calldata key)
        external
        view
        returns (string memory)
    {
        return _textRecords[node][key];
    }

    function deleteText(
        bytes32 node,
        string calldata key
    ) external onlyNodeOwner(node) whenNotPaused {
        delete _textRecords[node][key];
        emit RecordDeleted(node, key);
    }

    // ============ Address Records ============

    function setAddress(bytes32 node, address recordAddr) 
        external 
        onlyNodeOwner(node) 
        whenNotPaused 
    {
        _addresses[node] = recordAddr;
        emit AddressChanged(node, recordAddr);
    }

    function addr(bytes32 node) external view returns (address) {
        return _addresses[node];
    }

    function setCoinAddress(
        bytes32 node,
        uint256 coinType,
        bytes calldata coinAddr
    ) external onlyNodeOwner(node) whenNotPaused {
        _coinAddresses[node][coinType] = coinAddr;
        emit CoinAddressChanged(node, coinType, coinAddr);
    }

    function coinAddress(bytes32 node, uint256 coinType)
        external
        view
        returns (bytes memory)
    {
        return _coinAddresses[node][coinType];
    }

    // ============ Batch Operations ============

    function setMultipleTexts(
        bytes32 node,
        string[] calldata keys,
        string[] calldata values
    ) external onlyNodeOwner(node) whenNotPaused {
        require(keys.length == values.length, "Array length mismatch");
        
        for (uint256 i = 0; i < keys.length; i++) {
            _textRecords[node][keys[i]] = values[i];
            emit TextChanged(node, keys[i], values[i]);
        }
    }

    function deleteMultipleTexts(
        bytes32 node,
        string[] calldata keys
    ) external onlyNodeOwner(node) whenNotPaused {
        for (uint256 i = 0; i < keys.length; i++) {
            delete _textRecords[node][keys[i]];
            emit RecordDeleted(node, keys[i]);
        }
    }

    // ============ Internal Functions ============

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
            interfaceId == 0x3b3b57de || // ITextResolver
            interfaceId == 0xf1cb7e06 || // IAddressResolver  
            interfaceId == 0xf86bc879 || // ICoinAddressResolver
            super.supportsInterface(interfaceId);
    }
}
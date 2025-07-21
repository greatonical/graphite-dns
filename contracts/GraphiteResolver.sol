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
}

contract GraphiteResolver is AccessControl, Pausable {
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    
    IGraphiteDNSRegistry public immutable registry;

    // node → (key → value)
    mapping(bytes32 => mapping(string => string)) private _textRecords;
    
    // node → (interfaceId → implementer)
    mapping(bytes32 => mapping(bytes4 => address)) private _interfaces;
    
    // node → address (ETH address record)
    mapping(bytes32 => address) private _addresses;

    // Standard record keys
    string public constant AVATAR_KEY = "avatar";
    string public constant DESCRIPTION_KEY = "description";
    string public constant DISPLAY_KEY = "display";
    string public constant EMAIL_KEY = "email";
    string public constant KEYWORDS_KEY = "keywords";
    string public constant MAIL_KEY = "mail";
    string public constant NOTICE_KEY = "notice";
    string public constant LOCATION_KEY = "location";
    string public constant PHONE_KEY = "phone";
    string public constant URL_KEY = "url";
    string public constant CONTENTHASH_KEY = "contenthash";

    event TextChanged(bytes32 indexed node, string indexed key, string value);
    event AddressChanged(bytes32 indexed node, address addr);
    event InterfaceChanged(bytes32 indexed node, bytes4 indexed interfaceID, address implementer);

    constructor(address registryAddress) {
        registry = IGraphiteDNSRegistry(registryAddress);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RESOLVER_ROLE, msg.sender);
    }

    modifier onlyNodeOwnerOrAuthorized(bytes32 node) {
        IGraphiteDNSRegistry.Domain memory domain = registry.getDomain(node);
        require(
            domain.owner == msg.sender || 
            hasRole(RESOLVER_ROLE, msg.sender) ||
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "Not authorized for this domain"
        );
        require(domain.expiry > block.timestamp, "Domain expired");
        _;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ===== TEXT RECORDS =====

    /// @notice Set text record (domain owner or authorized)
    function setText(
        bytes32 node,
        string calldata key,
        string calldata value
    ) external onlyNodeOwnerOrAuthorized(node) whenNotPaused {
        _textRecords[node][key] = value;
        emit TextChanged(node, key, value);
    }

    /// @notice Get text record
    function text(bytes32 node, string calldata key)
        external
        view
        returns (string memory)
    {
        return _textRecords[node][key];
    }

    /// @notice Batch set multiple text records
    function setTextBatch(
        bytes32 node,
        string[] calldata keys,
        string[] calldata values
    ) external onlyNodeOwnerOrAuthorized(node) whenNotPaused {
        require(keys.length == values.length, "Array length mismatch");
        
        for (uint i = 0; i < keys.length; i++) {
            _textRecords[node][keys[i]] = values[i];
            emit TextChanged(node, keys[i], values[i]);
        }
    }

    /// @notice Clear text record
    function clearText(bytes32 node, string calldata key)
        external
        onlyNodeOwnerOrAuthorized(node)
        whenNotPaused
    {
        delete _textRecords[node][key];
        emit TextChanged(node, key, "");
    }

    // ===== ADDRESS RECORDS =====

    /// @notice Set ETH address for domain
    function setAddr(bytes32 node, address domainAddress)
        external
        onlyNodeOwnerOrAuthorized(node)
        whenNotPaused
    {
        _addresses[node] = domainAddress;
        emit AddressChanged(node, domainAddress);
    }

    /// @notice Get ETH address for domain
    function addr(bytes32 node) external view returns (address) {
        return _addresses[node];
    }

    // ===== INTERFACE SUPPORT =====

    /// @notice Set interface implementer
    function setInterface(
        bytes32 node,
        bytes4 interfaceID,
        address implementer
    ) external onlyNodeOwnerOrAuthorized(node) whenNotPaused {
        _interfaces[node][interfaceID] = implementer;
        emit InterfaceChanged(node, interfaceID, implementer);
    }

    /// @notice Get interface implementer
    function interfaceImplementer(bytes32 node, bytes4 interfaceID)
        external
        view
        returns (address)
    {
        return _interfaces[node][interfaceID];
    }

    // ===== CONVENIENCE FUNCTIONS =====

    /// @notice Set common profile data
    function setProfile(
        bytes32 node,
        string calldata displayName,
        string calldata description,
        string calldata avatar,
        string calldata url,
        address ethAddress
    ) external onlyNodeOwnerOrAuthorized(node) whenNotPaused {
        if (bytes(displayName).length > 0) {
            _textRecords[node][DISPLAY_KEY] = displayName;
            emit TextChanged(node, DISPLAY_KEY, displayName);
        }
        
        if (bytes(description).length > 0) {
            _textRecords[node][DESCRIPTION_KEY] = description;
            emit TextChanged(node, DESCRIPTION_KEY, description);
        }
        
        if (bytes(avatar).length > 0) {
            _textRecords[node][AVATAR_KEY] = avatar;
            emit TextChanged(node, AVATAR_KEY, avatar);
        }
        
        if (bytes(url).length > 0) {
            _textRecords[node][URL_KEY] = url;
            emit TextChanged(node, URL_KEY, url);
        }
        
        if (ethAddress != address(0)) {
            _addresses[node] = ethAddress;
            emit AddressChanged(node, ethAddress);
        }
    }

    /// @notice Get basic profile info
    function getProfile(bytes32 node)
        external
        view
        returns (
            string memory displayName,
            string memory description,
            string memory avatar,
            string memory url,
            address ethAddress
        )
    {
        return (
            _textRecords[node][DISPLAY_KEY],
            _textRecords[node][DESCRIPTION_KEY],
            _textRecords[node][AVATAR_KEY],
            _textRecords[node][URL_KEY],
            _addresses[node]
        );
    }

    /// @notice Clear all records for a domain
    function clearAllRecords(bytes32 node, string[] calldata textKeys)
        external
        onlyNodeOwnerOrAuthorized(node)
        whenNotPaused
    {
        // Clear text records
        for (uint i = 0; i < textKeys.length; i++) {
            delete _textRecords[node][textKeys[i]];
            emit TextChanged(node, textKeys[i], "");
        }
        
        // Clear address record
        delete _addresses[node];
        emit AddressChanged(node, address(0));
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
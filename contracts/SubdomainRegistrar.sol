// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

interface IGraphiteDNSRegistry {
    struct Record {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
        bool exists;
    }
    
    function getRecord(bytes32 node) external view returns (Record memory);
    function register(
        string calldata name,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    ) external payable returns (bytes32);
    function nodeOwner(bytes32 node) external view returns (address);
    function isAvailable(bytes32 node) external view returns (bool);
}

interface IReverseRegistrar {
    function addOwnedName(address addr, string calldata name) external;
    function removeOwnedName(address addr, string calldata name) external;
}

/**
 * @title SubdomainRegistrar
 * @dev Enhanced subdomain management with delegation vs ownership, automatic expiry inheritance
 */
contract SubdomainRegistrar is 
    AccessControl, 
    Pausable, 
    ReentrancyGuard,
    UUPSUpgradeable 
{
    IGraphiteDNSRegistry public immutable registry;
    IReverseRegistrar public reverseRegistrar;
    bytes32 public immutable TLD_NODE;
    
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    
    enum SubdomainType {
        MANAGED,    // Parent retains control and ownership
        DELEGATED,  // Parent delegates control but retains ownership
        SOLD        // Full ownership transfer to buyer
    }
    
    enum SubdomainStatus {
        INACTIVE,
        AVAILABLE,
        SOLD_OUT,
        PAUSED
    }
    
    struct SubdomainConfig {
        uint256 price;
        SubdomainType subType;
        SubdomainStatus status;
        uint64 maxDuration;
        bool requiresApproval;
        address[] approvedBuyers;
        mapping(address => bool) isApprovedBuyer;
        uint256 totalSold;
        uint256 maxSupply;
    }
    
    struct SubdomainRecord {
        bytes32 parentNode;
        address originalOwner;
        address currentOwner;
        SubdomainType subType;
        uint64 createdAt;
        uint64 lastRenewal;
        bool isActive;
    }
    
    // Parent node -> subdomain label -> config
    mapping(bytes32 => mapping(string => SubdomainConfig)) private _subdomainConfigs;
    
    // Subdomain node -> record
    mapping(bytes32 => SubdomainRecord) private _subdomainRecords;
    
    // Parent node -> list of subdomain labels
    mapping(bytes32 => string[]) private _subdomainLabels;
    mapping(bytes32 => mapping(string => bool)) private _labelExists;
    
    // Owner -> list of managed subdomains
    mapping(address => bytes32[]) private _managedSubdomains;
    mapping(address => mapping(bytes32 => bool)) private _isManaging;
    
    // Revenue tracking
    mapping(address => uint256) private _ownerEarnings;
    mapping(bytes32 => uint256) private _parentEarnings;
    
    event SubdomainConfigured(
        bytes32 indexed parentNode,
        string label,
        uint256 price,
        SubdomainType subType,
        SubdomainStatus status
    );
    
    event SubdomainCreated(
        bytes32 indexed subdomainNode,
        bytes32 indexed parentNode,
        string label,
        address indexed owner,
        SubdomainType subType,
        uint64 expiry
    );
    
    event SubdomainTransferred(
        bytes32 indexed subdomainNode,
        address indexed from,
        address indexed to,
        SubdomainType newType
    );
    
    event SubdomainStatusChanged(
        bytes32 indexed parentNode,
        string label,
        SubdomainStatus oldStatus,
        SubdomainStatus newStatus
    );
    
    event SubdomainRenewed(
        bytes32 indexed subdomainNode,
        uint64 newExpiry,
        uint256 cost
    );
    
    event EarningsWithdrawn(
        address indexed owner,
        uint256 amount
    );
    
    event ApprovedBuyerAdded(
        bytes32 indexed parentNode,
        string label,
        address indexed buyer
    );

    constructor(address _registry, address _reverseRegistrar) {
        registry = IGraphiteDNSRegistry(_registry);
        reverseRegistrar = IReverseRegistrar(_reverseRegistrar);
        TLD_NODE = keccak256(abi.encodePacked(bytes32(0), keccak256(bytes("atgraphite"))));
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MANAGER_ROLE, msg.sender);
    }

    modifier onlyParentOwner(bytes32 parentNode) {
        IGraphiteDNSRegistry.Record memory parent = registry.getRecord(parentNode);
        require(parent.owner == msg.sender, "Not parent owner");
        require(block.timestamp <= parent.expiry, "Parent expired");
        _;
    }

    modifier onlySubdomainOwner(bytes32 subdomainNode) {
        SubdomainRecord storage record = _subdomainRecords[subdomainNode];
        require(
            record.currentOwner == msg.sender || 
            (record.subType == SubdomainType.MANAGED && record.originalOwner == msg.sender),
            "Not subdomain owner"
        );
        _;
    }

    modifier validSubdomainName(string memory label) {
        require(bytes(label).length > 0 && bytes(label).length <= 63, "Invalid label length");
        require(_isValidLabel(label), "Invalid label format");
        _;
    }

    // Configure subdomain for sale/delegation
    function configureSubdomain(
        bytes32 parentNode,
        string calldata label,
        uint256 price,
        SubdomainType subType,
        uint64 maxDuration,
        uint256 maxSupply,
        bool requiresApproval
    )
        external
        onlyParentOwner(parentNode)
        validSubdomainName(label)
        whenNotPaused
    {
        SubdomainConfig storage config = _subdomainConfigs[parentNode][label];
        
        config.price = price;
        config.subType = subType;
        config.status = SubdomainStatus.AVAILABLE;
        config.maxDuration = maxDuration;
        config.requiresApproval = requiresApproval;
        config.maxSupply = maxSupply;
        
        if (!_labelExists[parentNode][label]) {
            _subdomainLabels[parentNode].push(label);
            _labelExists[parentNode][label] = true;
        }
        
        emit SubdomainConfigured(parentNode, label, price, subType, SubdomainStatus.AVAILABLE);
    }

    // Create managed subdomain (parent retains full control)
    function createManagedSubdomain(
        bytes32 parentNode,
        string calldata label,
        address resolver
    )
        external
        onlyParentOwner(parentNode)
        validSubdomainName(label)
        whenNotPaused
        nonReentrant
        returns (bytes32)
    {
        return _createSubdomain(
            parentNode,
            label,
            msg.sender,
            resolver,
            SubdomainType.MANAGED,
            0
        );
    }

    // Buy subdomain with payment
    function buySubdomain(
        bytes32 parentNode,
        string calldata label,
        address resolver
    )
        external
        payable
        whenNotPaused
        nonReentrant
        validSubdomainName(label)
        returns (bytes32)
    {
        SubdomainConfig storage config = _subdomainConfigs[parentNode][label];
        require(config.status == SubdomainStatus.AVAILABLE, "Subdomain not available");
        require(msg.value >= config.price, "Insufficient payment");
        
        if (config.requiresApproval) {
            require(config.isApprovedBuyer[msg.sender], "Not approved buyer");
        }
        
        if (config.maxSupply > 0) {
            require(config.totalSold < config.maxSupply, "Supply exhausted");
        }
        
        // Refund excess payment
        if (msg.value > config.price) {
            payable(msg.sender).transfer(msg.value - config.price);
        }
        
        // Track earnings
        address parentOwner = registry.nodeOwner(parentNode);
        _ownerEarnings[parentOwner] += config.price;
        _parentEarnings[parentNode] += config.price;
        
        // Update supply tracking
        config.totalSold++;
        if (config.maxSupply > 0 && config.totalSold >= config.maxSupply) {
            config.status = SubdomainStatus.SOLD_OUT;
        }
        
        // Determine owner based on subdomain type
        address subdomainOwner = (config.subType == SubdomainType.SOLD) ? msg.sender : parentOwner;
        
        return _createSubdomain(
            parentNode,
            label,
            subdomainOwner,
            resolver,
            config.subType,
            config.price
        );
    }

    // Transfer subdomain (only for SOLD type or by original owner)
    function transferSubdomain(
        bytes32 subdomainNode,
        address to,
        SubdomainType newType
    )
        external
        onlySubdomainOwner(subdomainNode)
        whenNotPaused
        nonReentrant
    {
        require(to != address(0), "Invalid recipient");
        
        SubdomainRecord storage record = _subdomainRecords[subdomainNode];
        require(record.isActive, "Subdomain not active");
        
        // Only SOLD subdomains can be freely transferred
        // MANAGED/DELEGATED can only be transferred by original owner
        if (record.subType != SubdomainType.SOLD) {
            require(msg.sender == record.originalOwner, "Only original owner can transfer");
        }
        
        address from = record.currentOwner;
        record.currentOwner = to;
        record.subType = newType;
        
        // Update management tracking
        if (record.subType == SubdomainType.MANAGED || record.subType == SubdomainType.DELEGATED) {
            if (!_isManaging[to][subdomainNode]) {
                _managedSubdomains[to].push(subdomainNode);
                _isManaging[to][subdomainNode] = true;
            }
        }
        
        // Update reverse registrar
        if (address(reverseRegistrar) != address(0)) {
            try reverseRegistrar.removeOwnedName(from, "") {} catch {}
            try reverseRegistrar.addOwnedName(to, "") {} catch {}
        }
        
        emit SubdomainTransferred(subdomainNode, from, to, newType);
    }

    // Renew subdomain (inherits parent expiry or extends if allowed)
    function renewSubdomain(bytes32 subdomainNode)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        SubdomainRecord storage record = _subdomainRecords[subdomainNode];
        require(record.isActive, "Subdomain not active");
        require(
            record.currentOwner == msg.sender || 
            record.originalOwner == msg.sender,
            "Not authorized to renew"
        );
        
        IGraphiteDNSRegistry.Record memory parent = registry.getRecord(record.parentNode);
        require(parent.exists, "Parent does not exist");
        
        // For managed/delegated subdomains, automatically inherit parent expiry
        uint64 newExpiry = parent.expiry;
        uint256 cost = 0;
        
        // For sold subdomains, allow manual renewal with cost
        if (record.subType == SubdomainType.SOLD) {
            SubdomainConfig storage config = _getConfigForSubdomain(subdomainNode);
            cost = config.price / 10; // 10% of original price for renewal
            require(msg.value >= cost, "Insufficient renewal fee");
            
            if (msg.value > cost) {
                payable(msg.sender).transfer(msg.value - cost);
            }
            
            _ownerEarnings[record.originalOwner] += cost;
        }
        
        record.lastRenewal = uint64(block.timestamp);
        
        emit SubdomainRenewed(subdomainNode, newExpiry, cost);
    }

    // Add approved buyer
    function addApprovedBuyer(
        bytes32 parentNode,
        string calldata label,
        address buyer
    )
        external
        onlyParentOwner(parentNode)
        whenNotPaused
    {
        SubdomainConfig storage config = _subdomainConfigs[parentNode][label];
        require(!config.isApprovedBuyer[buyer], "Already approved");
        
        config.approvedBuyers.push(buyer);
        config.isApprovedBuyer[buyer] = true;
        
        emit ApprovedBuyerAdded(parentNode, label, buyer);
    }

    // Change subdomain status
    function setSubdomainStatus(
        bytes32 parentNode,
        string calldata label,
        SubdomainStatus newStatus
    )
        external
        onlyParentOwner(parentNode)
        whenNotPaused
    {
        SubdomainConfig storage config = _subdomainConfigs[parentNode][label];
        SubdomainStatus oldStatus = config.status;
        config.status = newStatus;
        
        emit SubdomainStatusChanged(parentNode, label, oldStatus, newStatus);
    }

    // Withdraw earnings
    function withdrawEarnings() external nonReentrant {
        uint256 amount = _ownerEarnings[msg.sender];
        require(amount > 0, "No earnings to withdraw");
        
        _ownerEarnings[msg.sender] = 0;
        
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Withdrawal failed");
        
        emit EarningsWithdrawn(msg.sender, amount);
    }

    // Internal functions
    function _createSubdomain(
        bytes32 parentNode,
        string memory label,
        address owner,
        address resolver,
        SubdomainType subType,
        uint256 cost
    ) internal returns (bytes32) {
        bytes32 subdomainNode = keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
        require(registry.isAvailable(subdomainNode), "Subdomain not available");
        
        // Get parent expiry for inheritance
        IGraphiteDNSRegistry.Record memory parent = registry.getRecord(parentNode);
        uint64 duration = parent.expiry - uint64(block.timestamp);
        
        // Register subdomain in main registry
        try registry.register(label, owner, duration, resolver, parentNode) {
            // Create subdomain record
            _subdomainRecords[subdomainNode] = SubdomainRecord({
                parentNode: parentNode,
                originalOwner: registry.nodeOwner(parentNode),
                currentOwner: owner,
                subType: subType,
                createdAt: uint64(block.timestamp),
                lastRenewal: uint64(block.timestamp),
                isActive: true
            });
            
            // Track managed subdomains
            if (subType == SubdomainType.MANAGED || subType == SubdomainType.DELEGATED) {
                if (!_isManaging[owner][subdomainNode]) {
                    _managedSubdomains[owner].push(subdomainNode);
                    _isManaging[owner][subdomainNode] = true;
                }
            }
            
            // Update reverse registrar
            if (address(reverseRegistrar) != address(0)) {
                string memory fullName = string.concat(label, ".", _getParentName(parentNode));
                try reverseRegistrar.addOwnedName(owner, fullName) {} catch {}
            }
            
            emit SubdomainCreated(subdomainNode, parentNode, label, owner, subType, parent.expiry);
            return subdomainNode;
            
        } catch {
            revert("Subdomain registration failed");
        }
    }

    function _getConfigForSubdomain(bytes32 subdomainNode) internal view returns (SubdomainConfig storage) {
        SubdomainRecord storage record = _subdomainRecords[subdomainNode];
        string memory label = _getSubdomainLabel(subdomainNode);
        return _subdomainConfigs[record.parentNode][label];
    }

    function _getSubdomainLabel(bytes32 subdomainNode) internal view returns (string memory) {
        // This would need to be tracked or computed differently in practice
        // For now, returning empty string as placeholder
        return "";
    }

    function _getParentName(bytes32 parentNode) internal view returns (string memory) {
        // This would need to be retrieved from registry or cached
        // For now, returning placeholder
        return "atgraphite";
    }

    function _isValidLabel(string memory label) internal pure returns (bool) {
        bytes memory labelBytes = bytes(label);
        
        for (uint256 i = 0; i < labelBytes.length; i++) {
            bytes1 char = labelBytes[i];
            
            if (!(
                (char >= 0x30 && char <= 0x39) || // 0-9
                (char >= 0x61 && char <= 0x7A) || // a-z
                (char == 0x2D && i > 0 && i < labelBytes.length - 1) // hyphen not at start/end
            )) {
                return false;
            }
        }
        
        return true;
    }

    // View functions
    function getSubdomainConfig(bytes32 parentNode, string calldata label)
        external
        view
        returns (
            uint256 price,
            SubdomainType subType,
            SubdomainStatus status,
            uint64 maxDuration,
            bool requiresApproval,
            uint256 totalSold,
            uint256 maxSupply
        )
    {
        SubdomainConfig storage config = _subdomainConfigs[parentNode][label];
        return (
            config.price,
            config.subType,
            config.status,
            config.maxDuration,
            config.requiresApproval,
            config.totalSold,
            config.maxSupply
        );
    }

    function getSubdomainRecord(bytes32 subdomainNode)
        external
        view
        returns (SubdomainRecord memory)
    {
        return _subdomainRecords[subdomainNode];
    }

    function getSubdomainLabels(bytes32 parentNode) external view returns (string[] memory) {
        return _subdomainLabels[parentNode];
    }

    function getManagedSubdomains(address owner) external view returns (bytes32[] memory) {
        return _managedSubdomains[owner];
    }

    function getOwnerEarnings(address owner) external view returns (uint256) {
        return _ownerEarnings[owner];
    }

    function getParentEarnings(bytes32 parentNode) external view returns (uint256) {
        return _parentEarnings[parentNode];
    }

    function isApprovedBuyer(bytes32 parentNode, string calldata label, address buyer) 
        external 
        view 
        returns (bool) 
    {
        return _subdomainConfigs[parentNode][label].isApprovedBuyer[buyer];
    }

    function getApprovedBuyers(bytes32 parentNode, string calldata label) 
        external 
        view 
        returns (address[] memory) 
    {
        return _subdomainConfigs[parentNode][label].approvedBuyers;
    }

    // Admin functions
    function setReverseRegistrar(address _reverseRegistrar) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        reverseRegistrar = IReverseRegistrar(_reverseRegistrar);
    }

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
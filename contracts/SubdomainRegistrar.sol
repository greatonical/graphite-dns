// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./GraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SubdomainRegistrar is AccessControl, Pausable, ReentrancyGuard {
    GraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;

    struct SubdomainConfig {
        uint256 price;
        bool allowPublicRegistration;
        uint64 maxDuration;
        address beneficiary;
    }

    mapping(bytes32 => mapping(string => SubdomainConfig)) private _subdomainConfigs;
    mapping(bytes32 => bool) public subdomainRegistrationEnabled;

    event SubdomainConfigured(
        bytes32 indexed parent,
        string label,
        uint256 price,
        bool allowPublicRegistration,
        uint64 maxDuration,
        address beneficiary
    );
    
    event SubdomainRegistered(
        bytes32 indexed node,
        bytes32 indexed parent,
        string label,
        address owner,
        uint64 expiry,
        uint256 paid
    );

    constructor(address registryAddress) {
        registry = GraphiteDNSRegistry(registryAddress);
        TLD_NODE = registry.TLD_NODE();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ===== PARENT DOMAIN OWNER FUNCTIONS =====

    function setSubdomainRegistrationEnabled(
        bytes32 parentNode,
        bool enabled
    ) external {
        require(
            registry.getDomain(parentNode).owner == msg.sender,
            "Not parent owner"
        );
        subdomainRegistrationEnabled[parentNode] = enabled;
    }

    function configureSubdomain(
        bytes32 parentNode,
        string calldata label,
        uint256 price,
        bool allowPublicRegistration,
        uint64 maxDuration,
        address beneficiary
    ) external whenNotPaused {
        require(
            registry.getDomain(parentNode).owner == msg.sender,
            "Not parent owner"
        );
        
        // Set defaults to avoid stack issues
        if (beneficiary == address(0)) {
            beneficiary = msg.sender;
        }
        if (maxDuration == 0) {
            maxDuration = uint64(365 days);
        }
        
        _subdomainConfigs[parentNode][label] = SubdomainConfig(
            price,
            allowPublicRegistration,
            maxDuration,
            beneficiary
        );

        emit SubdomainConfigured(
            parentNode,
            label,
            price,
            allowPublicRegistration,
            maxDuration,
            beneficiary
        );
    }

    function registerSubdomainForUser(
        bytes32 parentNode,
        string calldata label,
        address owner_,
        uint64 duration,
        address resolver_
    ) external whenNotPaused nonReentrant returns (bytes32) {
        require(
            registry.getDomain(parentNode).owner == msg.sender,
            "Not parent owner"
        );
        
        return _performRegistration(RegistrationParams({
            parentNode: parentNode,
            label: label,
            owner: owner_,
            duration: duration,
            resolver: resolver_,
            paid: 0
        }));
    }

    // ===== PUBLIC REGISTRATION FUNCTIONS =====

    function getSubdomainConfig(
        bytes32 parentNode,
        string calldata label
    ) external view returns (SubdomainConfig memory) {
        return _subdomainConfigs[parentNode][label];
    }

    function priceOfSubdomain(
        bytes32 parentNode,
        string calldata label,
        uint64 duration
    ) external view returns (uint256) {
        uint256 basePrice = _subdomainConfigs[parentNode][label].price;
        bool isConfigured = _subdomainConfigs[parentNode][label].allowPublicRegistration;
        
        require(basePrice > 0 || isConfigured, "Not configured");
        
        if (basePrice == 0) return 0;
        
        uint256 durationYears = duration / 365 days;
        if (durationYears == 0) durationYears = 1;
        
        return basePrice * durationYears;
    }

    function buySubdomain(
        bytes32 parentNode,
        string calldata label,
        uint64 duration,
        address resolver_
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        require(subdomainRegistrationEnabled[parentNode], "Registration disabled");
        
        // Check configuration
        SubdomainConfig storage config = _subdomainConfigs[parentNode][label];
        require(config.allowPublicRegistration, "Private subdomain");
        require(duration <= config.maxDuration, "Duration too long");
        
        // Calculate and validate payment
        uint256 price = this.priceOfSubdomain(parentNode, label, duration);
        require(msg.value >= price, "Insufficient payment");

        // Handle payment
        _handlePayment(price, config.beneficiary);

        return _performRegistration(RegistrationParams({
            parentNode: parentNode,
            label: label,
            owner: msg.sender,
            duration: duration,
            resolver: resolver_,
            paid: price
        }));
    }

    // ===== LEGACY COMPATIBILITY =====

    function setSubdomainPrice(
        bytes32 parentNode,
        string calldata label,
        uint256 price
    ) external {
        require(
            registry.getDomain(parentNode).owner == msg.sender,
            "Not parent owner"
        );
        
        _subdomainConfigs[parentNode][label] = SubdomainConfig(
            price,
            price > 0,
            uint64(365 days * 10),
            msg.sender
        );
        
        subdomainRegistrationEnabled[parentNode] = true;
    }

    function buySubdomainFixedPrice(
        bytes32 parentNode,
        string calldata label,
        address resolver_,
        uint64 duration
    ) external payable returns (bytes32) {
        return this.buySubdomain{value: msg.value}(parentNode, label, duration, resolver_);
    }

    struct RegistrationParams {
        bytes32 parentNode;
        string label;
        address owner;
        uint64 duration;
        address resolver;
        uint256 paid;
    }

    // ===== INTERNAL FUNCTIONS =====

    function _handlePayment(uint256 price, address beneficiary) internal {
        if (msg.value > price) {
            payable(msg.sender).transfer(msg.value - price);
        }

        if (price > 0) {
            payable(beneficiary).transfer(price);
        }
    }

    function _performRegistration(RegistrationParams memory params) internal returns (bytes32) {
        // Validate parent domain in a single call
        GraphiteDNSRegistry.Domain memory parent = registry.getDomain(params.parentNode);
        require(parent.owner != address(0), "Parent doesn't exist");
        require(parent.expiry > block.timestamp, "Parent expired");
        
        // Register subdomain
        bytes32 node = registry.register{value: 0}(
            params.label,
            params.owner,
            params.duration,
            params.resolver,
            params.parentNode
        );

        // Emit event
        emit SubdomainRegistered(
            node, 
            params.parentNode, 
            params.label, 
            params.owner, 
            uint64(block.timestamp + params.duration), 
            params.paid
        );
        
        return node;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
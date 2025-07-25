// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IGraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SubdomainRegistrar is AccessControl, Pausable, ReentrancyGuard {
    IGraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;

    struct SubdomainConfig {
        uint256 price;
        bool transferOwnership;  // If true, parent loses control
        bool isActive;
    }

    // parent node => label => config
    mapping(bytes32 => mapping(string => SubdomainConfig)) private _subdomainConfigs;
    
    // parent node => owner => operator approval
    mapping(bytes32 => mapping(address => bool)) private _operatorApprovals;

    event SubdomainConfigured(
        bytes32 indexed parent,
        string label,
        uint256 price,
        bool transferOwnership
    );
    event SubdomainRegistered(
        bytes32 indexed node,
        bytes32 indexed parent,
        string label,
        address indexed owner,
        bool transferred
    );
    event OperatorApprovalChanged(
        bytes32 indexed parent,
        address indexed owner,
        address indexed operator,
        bool approved
    );

    modifier onlyParentOwner(bytes32 parentNode) {
        require(_isParentOwner(parentNode, msg.sender), "Not parent owner or expired");
        _;
    }

    modifier onlyParentOwnerOrOperator(bytes32 parentNode) {
        address parentOwner = _getParentOwner(parentNode);
        require(
            msg.sender == parentOwner || _operatorApprovals[parentNode][msg.sender],
            "Not authorized"
        );
        _;
    }

    constructor(address registryAddress) {
        registry = IGraphiteDNSRegistry(registryAddress);
        TLD_NODE = registry.TLD_NODE();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // Admin pause/unpause
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ============ Configuration Functions ============

    function configureSubdomain(
        bytes32 parentNode,
        string calldata label,
        uint256 price,
        bool transferOwnership
    ) external onlyParentOwner(parentNode) whenNotPaused {
        require(bytes(label).length > 0, "Empty label");
        _subdomainConfigs[parentNode][label] = SubdomainConfig({
            price: price,
            transferOwnership: transferOwnership,
            isActive: true
        });
        emit SubdomainConfigured(parentNode, label, price, transferOwnership);
    }

    function deactivateSubdomain(
        bytes32 parentNode,
        string calldata label
    ) external onlyParentOwner(parentNode) whenNotPaused {
        _subdomainConfigs[parentNode][label].isActive = false;
        emit SubdomainConfigured(parentNode, label, 0, false);
    }

    function setOperatorApproval(
        bytes32 parentNode,
        address operator,
        bool approved
    ) external onlyParentOwner(parentNode) {
        _operatorApprovals[parentNode][operator] = approved;
        emit OperatorApprovalChanged(parentNode, msg.sender, operator, approved);
    }

    // ============ Registration Functions ============

    function registerSubdomain(
        bytes32 parentNode,
        string calldata label,
        address to,
        address resolver_,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        // Use a helper to split stack variables
        SubdomainConfig memory config = _subdomainConfigs[parentNode][label];
        require(config.isActive, "Subdomain not available");
        require(msg.value >= config.price, "Insufficient payment");
        _refundIfOver(msg.value, config.price);

        // Who gets ownership of subdomain?
        address finalOwner = config.transferOwnership ? to : _getParentOwner(parentNode);

        // Use internal helper to avoid stack too deep
        return _doRegisterSubdomain(parentNode, label, finalOwner, resolver_, duration, config.transferOwnership);
    }

    function createInternalSubdomain(
        bytes32 parentNode,
        string calldata label,
        address resolver_,
        uint64 duration
    ) external onlyParentOwnerOrOperator(parentNode) whenNotPaused returns (bytes32) {
        address parentOwner = _getParentOwner(parentNode);
        return _doRegisterSubdomain(parentNode, label, parentOwner, resolver_, duration, false);
    }

    function _doRegisterSubdomain(
        bytes32 parentNode,
        string calldata label,
        address finalOwner,
        address resolver_,
        uint64 duration,
        bool transferred
    ) internal returns (bytes32) {
        bytes32 registeredNode = registry.register{
            value: msg.value
        }(
            label,
            finalOwner,
            duration,
            resolver_,
            parentNode
        );
        emit SubdomainRegistered(registeredNode, parentNode, label, finalOwner, transferred);
        return registeredNode;
    }

    function _refundIfOver(uint256 sent, uint256 required) internal {
        if (sent > required) {
            payable(msg.sender).transfer(sent - required);
        }
    }

    // ============ View Functions ============

    function getSubdomainConfig(
        bytes32 parentNode,
        string calldata label
    ) external view returns (SubdomainConfig memory) {
        return _subdomainConfigs[parentNode][label];
    }

    function priceOfSubdomain(
        bytes32 parentNode,
        string calldata label
    ) external view returns (uint256) {
        SubdomainConfig memory config = _subdomainConfigs[parentNode][label];
        require(config.isActive, "Subdomain not available");
        return config.price;
    }

    function isOperatorApproved(
        bytes32 parentNode,
        address operator
    ) external view returns (bool) {
        return _operatorApprovals[parentNode][operator];
    }

    // ============ Internal Functions ============

    function _isParentOwner(bytes32 parentNode, address account) internal view returns (bool) {
        try registry.getDomain(parentNode) returns (IGraphiteDNSRegistry.Domain memory domain) {
            if (domain.owner != account) return false;
            if (domain.expiry == type(uint64).max) return true;
            return domain.expiry >= block.timestamp;
        } catch {
            return false;
        }
    }

    function _getParentOwner(bytes32 parentNode) internal view returns (address) {
        try registry.getDomain(parentNode) returns (IGraphiteDNSRegistry.Domain memory domain) {
            return domain.owner;
        } catch {
            return address(0);
        }
    }

    // ============ Emergency Functions ============

    function withdraw() external onlyRole(DEFAULT_ADMIN_ROLE) {
        payable(msg.sender).transfer(address(this).balance);
    }

    // ============ Interface Support ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

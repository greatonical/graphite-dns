// contracts/SubdomainRegistrar.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./GraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SubdomainRegistrar is AccessControl, Pausable, ReentrancyGuard {
    GraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;

    mapping(bytes32 => mapping(string => uint256)) private _prices;

    event SubdomainPriceSet(
        bytes32 indexed parent,
        string label,
        uint256 price
    );
    event SubdomainRegistered(
        bytes32 indexed node,
        string label,
        address owner,
        uint64 expiry
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

    function setSubdomainPrice(
        bytes32 parentNode,
        string calldata label,
        uint256 price
    ) external whenNotPaused {
        // only the owner of that parent node may set prices
        require(
            registry.getDomain(parentNode).owner == msg.sender,
            "Not parent owner"
        );
        _prices[parentNode][label] = price;
        emit SubdomainPriceSet(parentNode, label, price);
    }

    function priceOfSubdomain(
        bytes32 parentNode,
        string calldata label
    ) external view returns (uint256) {
        uint256 p = _prices[parentNode][label];
        require(p > 0, "Price not set");
        return p;
    }

    function buySubdomainFixedPrice(
        bytes32 parentNode,
        string calldata label,
        address resolver_,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        uint256 price = _prices[parentNode][label];
        require(price > 0, "Price not set");
        require(msg.value >= price, "Insufficient ETH");

        // refund any overpayment
        if (msg.value > price) {
            payable(msg.sender).transfer(msg.value - price);
        }

        // delegate to registry
        bytes32 node = registry.register{value: price}(
            label,
            msg.sender,
            duration,
            resolver_,
            parentNode
        );

        uint64 expiry = uint64(block.timestamp + duration);
        emit SubdomainRegistered(node, label, msg.sender, expiry);
        return node;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./GraphiteDNSRegistry.sol";

contract SubdomainRegistrar is GraphiteDNSRegistry {
    /// parentNode → sublabel → price in wei
    mapping(bytes32 => mapping(string => uint256)) public subdomainFixedPrice;

    /// Parent-owner sets the fixed price for a specific sublabel
    function setSubdomainPrice(
        bytes32 parentNode,
        string calldata label,
        uint256 price
    ) external {
        // only the owner of the parent domain may sell subdomains
        Domain storage pd = _domains[parentNode];
        require(pd.owner == msg.sender, "Not parent owner");

        subdomainFixedPrice[parentNode][label] = price;
    }

    /// Anyone can query the on-chain price before buying
    function priceOfSubdomain(bytes32 parentNode, string calldata label)
        external
        view
        returns (uint256)
    {
        uint256 p = subdomainFixedPrice[parentNode][label];
        require(p > 0, "Price not set");
        return p;
    }

    /// Purchase & mint a subdomain at its fixed price
    function buySubdomainFixedPrice(
        bytes32 parentNode,
        string calldata label,
        address resolver,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32)
    {
        bytes32 node = _makeNode(parentNode, label);
        require(isAvailable(node), "Taken or in grace");

        uint256 price = subdomainFixedPrice[parentNode][label];
        require(price > 0, "Price not set");
        require(msg.value >= price, "Insufficient ETH");

        // reuse the core registrar’s helper for mint, expiry, events
        return _registerDomain(node, label, msg.sender, duration, resolver, parentNode);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./GraphiteDNSRegistry.sol";

contract SubdomainRegistrar is GraphiteDNSRegistry {
    constructor(address resolverForTLD)
        GraphiteDNSRegistry(resolverForTLD)
    {}

    mapping(bytes32 => mapping(string => uint256)) public subdomainFixedPrice;

    function setSubdomainPrice(
        bytes32 parentNode,
        string calldata label,
        uint256 price
    ) external {
        Domain storage pd = _domains[parentNode];
        require(pd.owner == msg.sender, "Not parent owner");
        subdomainFixedPrice[parentNode][label] = price;
    }

    function priceOfSubdomain(bytes32 parentNode, string calldata label)
        external
        view
        returns (uint256)
    {
        uint256 p = subdomainFixedPrice[parentNode][label];
        require(p > 0, "Price not set");
        return p;
    }

    function buySubdomainFixedPrice(
        bytes32 parentNode,
        string calldata label,
        address resolver,
        uint64 duration
    ) external payable whenNotPaused nonReentrant returns (bytes32) {
        bytes32 node = _makeNode(parentNode, label);
        require(isAvailable(node), "Taken");
        uint256 price = subdomainFixedPrice[parentNode][label];
        require(price > 0 && msg.value >= price, "Insufficient ETH");
        return _registerDomain(node, label, msg.sender, duration, resolver, parentNode);
    }
}

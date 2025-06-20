// contracts/SubdomainRegistrar.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./GraphiteDNSRegistry.sol";

contract SubdomainRegistrar is GraphiteDNSRegistry {
    mapping(bytes32 => mapping(string => bool)) private _subdomainTaken;

    function registerSubdomain(
        bytes32 parentNode,
        string calldata label,
        address owner,
        uint64 duration,
        address resolver
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused nonReentrant returns (bytes32) {
        require(_domains[parentNode].owner == msg.sender, "Not parent owner");
        bytes32 node = _makeNode(parentNode, label);
        require(isAvailable(node), "Taken");
        _subdomainTaken[parentNode][label] = true;

        _domains[node] = Domain({
            owner: owner,
            resolver: resolver,
            expiry: uint64(block.timestamp + duration),
            parent: parentNode
        });
        _labels[node] = label;
        _nodeOfLabel[label] = node;

        uint256 tid = nextId++;
        _safeMint(owner, tid);
        emit DomainRegistered(node, label, owner, _domains[node].expiry);
        if (resolver != address(0)) emit ResolverUpdated(node, resolver);
        return node;
    }
}

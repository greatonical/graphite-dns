// contracts/interfaces/IGraphiteDNSRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IGraphiteDNSRegistry {
    struct Domain {
        address owner;
        address resolver;
        uint64 expiry;
        bytes32 parent;
    }

    function TLD_NODE() external view returns (bytes32);
    function getDomain(bytes32 node) external view returns (Domain memory);
    function getLabel(bytes32 node) external view returns (string memory);
    function isAvailable(bytes32 node) external view returns (bool);
    function isExpired(bytes32 node) external view returns (bool);
    function register(
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    ) external payable returns (bytes32);
}
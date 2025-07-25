// contracts/interfaces/IReverseRegistrar.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IReverseRegistrar {
    function updateReverse(address from, address to, bytes32 node) external;
    function getReverse(address addr) external view returns (string memory);
}
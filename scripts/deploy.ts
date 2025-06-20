// scripts/deploy.ts
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with", deployer.address);

  // 1. Core registrar
  const Registry = await ethers.getContractFactory("GraphiteDNSRegistry");
  const registry = await Registry.deploy();
  await registry.deployed();
  console.log("GraphiteDNSRegistry ➡", registry.address);

  // 2. Auction module
  const Auction = await ethers.getContractFactory("AuctionRegistrar");
  const auction = await Auction.deploy();
  await auction.deployed();
  console.log("AuctionRegistrar ➡", auction.address);

  // 3. Subdomain module
  const Sub = await ethers.getContractFactory("SubdomainRegistrar");
  const subdomain = await Sub.deploy();
  await subdomain.deployed();
  console.log("SubdomainRegistrar ➡", subdomain.address);

  // 4. Resolver
  const Resolver = await ethers.getContractFactory("GraphiteResolver");
  const resolver = await Resolver.deploy();
  await resolver.deployed();
  console.log("GraphiteResolver ➡", resolver.address);

  // 5. Reverse lookup
  const Reverse = await ethers.getContractFactory("ReverseRegistrar");
  const reverse = await Reverse.deploy();
  await reverse.deployed();
  console.log("ReverseRegistrar ➡", reverse.address);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

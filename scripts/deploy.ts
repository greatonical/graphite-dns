import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  // 1) Deploy resolver
  const Resolver = await ethers.getContractFactory("GraphiteResolver");
  const resolver = await Resolver.deploy();
  await resolver.deployed();

  // 2) Deploy core registry with resolverForTLD
  const Registry = await ethers.getContractFactory("GraphiteDNSRegistry");
  const registry = await Registry.deploy(resolver.address);
  await registry.deployed();

  // 3) Deploy AuctionRegistrar
  const Auction = await ethers.getContractFactory("AuctionRegistrar");
  const auction = await Auction.deploy(resolver.address);
  await auction.deployed();

  // 4) Deploy SubdomainRegistrar
  const Subdomain = await ethers.getContractFactory("SubdomainRegistrar");
  const subdomain = await Subdomain.deploy(resolver.address);
  await subdomain.deployed();

  // 5) Deploy ReverseRegistrar
  const Reverse = await ethers.getContractFactory("ReverseRegistrar");
  const reverse = await Reverse.deploy();
  await reverse.deployed();

  console.log("GraphiteResolver:      ", resolver.address);
  console.log("GraphiteDNSRegistry:   ", registry.address);
  console.log("AuctionRegistrar:      ", auction.address);
  console.log("SubdomainRegistrar:    ", subdomain.address);
  console.log("ReverseRegistrar:      ", reverse.address);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

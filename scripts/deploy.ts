import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with", deployer.address);

  // 1) GraphiteResolver
  const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
  const resolver = await ResolverFactory.deploy();
  await resolver.waitForDeployment();
  console.log("GraphiteResolver ➡", resolver.target);

  // 2) GraphiteDNSRegistry
  const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
  const registry = await RegistryFactory.deploy(resolver.target);
  await registry.waitForDeployment();
  console.log("GraphiteDNSRegistry ➡", registry.target);

  // 3) AuctionRegistrar
  const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
  const auction = await AuctionFactory.deploy(resolver.target);
  await auction.waitForDeployment();
  console.log("AuctionRegistrar ➡", auction.target);

  // 4) SubdomainRegistrar
  const SubFactory = await ethers.getContractFactory("SubdomainRegistrar");
  const subdomain = await SubFactory.deploy(resolver.target);
  await subdomain.waitForDeployment();
  console.log("SubdomainRegistrar ➡", subdomain.target);

  // 5) ReverseRegistrar
  const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
  const reverse = await ReverseFactory.deploy();
  await reverse.waitForDeployment();
  console.log("ReverseRegistrar ➡", reverse.target);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// scripts/deploy.ts
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with", await deployer.getAddress());

  // 1) GraphiteResolver
  const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
  const resolver = await ResolverFactory.deploy();
  await resolver.waitForDeployment();
  const resolverAddress = await resolver.getAddress();
  console.log("GraphiteResolver ➡", resolverAddress);

  // 2) GraphiteDNSRegistry
  const RegistryFactory = await ethers.getContractFactory(
    "GraphiteDNSRegistry"
  );
  const registry = await RegistryFactory.deploy(resolverAddress);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("GraphiteDNSRegistry ➡", registryAddress);

  // 3) AuctionRegistrar
  const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
  const auction = await AuctionFactory.deploy(registryAddress);
  await auction.waitForDeployment();
  const auctionAddress = await auction.getAddress();
  console.log("AuctionRegistrar ➡", auctionAddress);

  // grant REGISTRAR_ROLE so AuctionRegistrar can mint
  const registrarRole = await registry.REGISTRAR_ROLE();
  await registry.grantRole(registrarRole, auctionAddress);

  // 4) SubdomainRegistrar
  const SubFactory = await ethers.getContractFactory("SubdomainRegistrar");
  const subdomain = await SubFactory.deploy(registryAddress);
  await subdomain.waitForDeployment();
  const subAddress = await subdomain.getAddress();
  console.log("SubdomainRegistrar ➡", subAddress);

  // grant REGISTRAR_ROLE so SubdomainRegistrar can mint
  await registry.grantRole(registrarRole, subAddress);

  // 5) ReverseRegistrar
  const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
  const reverse = await ReverseFactory.deploy();
  await reverse.waitForDeployment();
  const reverseAddress = await reverse.getAddress();
  console.log("ReverseRegistrar ➡", reverseAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

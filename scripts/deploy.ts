// scripts/deploy.ts
import { ethers, network } from "hardhat";
import { writeFileSync } from "fs";

interface DeploymentResult {
  network: string;
  deployer: string;
  contracts: {
    registry: string;
    resolver: string;
    reverseRegistrar: string;
    auctionRegistrar: string;
    subdomainRegistrar: string;
  };
  gasUsed: {
    registry: bigint;
    resolver: bigint;
    reverseRegistrar: bigint;
    auctionRegistrar: bigint;
    subdomainRegistrar: bigint;
  };
  timestamp: number;
}

async function main() {
  console.log("🚀 Deploying GraphiteDNS System...\n");
  
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const initialBalance = await ethers.provider.getBalance(deployerAddress);
  
  console.log("📋 Deployment Configuration:");
  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Initial Balance: ${ethers.formatEther(initialBalance)} ETH\n`);

  const deploymentResult: DeploymentResult = {
    network: network.name,
    deployer: deployerAddress,
    contracts: {
      registry: "",
      resolver: "",
      reverseRegistrar: "",
      auctionRegistrar: "",
      subdomainRegistrar: ""
    },
    gasUsed: {
      registry: 0n,
      resolver: 0n,
      reverseRegistrar: 0n,
      auctionRegistrar: 0n,
      subdomainRegistrar: 0n
    },
    timestamp: Math.floor(Date.now() / 1000)
  };

  try {
    // 1. Deploy GraphiteResolver (needs registry address, so deploy with placeholder first)
    console.log("1️⃣ Deploying GraphiteResolver...");
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const resolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    await resolver.waitForDeployment();
    const resolverAddress = await resolver.getAddress();
    
    const resolverReceipt = await resolver.deploymentTransaction()?.wait();
    deploymentResult.contracts.resolver = resolverAddress;
    deploymentResult.gasUsed.resolver = resolverReceipt?.gasUsed || 0n;
    
    console.log(`   ✅ GraphiteResolver deployed: ${resolverAddress}`);
    console.log(`   ⛽ Gas used: ${resolverReceipt?.gasUsed}\n`);

    // 2. Deploy GraphiteDNSRegistry
    console.log("2️⃣ Deploying GraphiteDNSRegistry...");
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    const registry = await RegistryFactory.deploy(resolverAddress, "atgraphite");
    await registry.waitForDeployment();
    const registryAddress = await registry.getAddress();
    
    const registryReceipt = await registry.deploymentTransaction()?.wait();
    deploymentResult.contracts.registry = registryAddress;
    deploymentResult.gasUsed.registry = registryReceipt?.gasUsed || 0n;
    
    console.log(`   ✅ GraphiteDNSRegistry deployed: ${registryAddress}`);
    console.log(`   ⛽ Gas used: ${registryReceipt?.gasUsed}\n`);

    // 3. Deploy new resolver with correct registry address
    console.log("3️⃣ Deploying GraphiteResolver (with registry)...");
    const resolverWithRegistry = await ResolverFactory.deploy(registryAddress);
    await resolverWithRegistry.waitForDeployment();
    const finalResolverAddress = await resolverWithRegistry.getAddress();
    
    const finalResolverReceipt = await resolverWithRegistry.deploymentTransaction()?.wait();
    deploymentResult.contracts.resolver = finalResolverAddress;
    deploymentResult.gasUsed.resolver = finalResolverReceipt?.gasUsed || 0n;
    
    console.log(`   ✅ GraphiteResolver (final) deployed: ${finalResolverAddress}`);
    console.log(`   ⛽ Gas used: ${finalResolverReceipt?.gasUsed}\n`);

    // 4. Deploy ReverseRegistrar
    console.log("4️⃣ Deploying ReverseRegistrar...");
    const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
    const reverse = await ReverseFactory.deploy(registryAddress);
    await reverse.waitForDeployment();
    const reverseAddress = await reverse.getAddress();
    
    const reverseReceipt = await reverse.deploymentTransaction()?.wait();
    deploymentResult.contracts.reverseRegistrar = reverseAddress;
    deploymentResult.gasUsed.reverseRegistrar = reverseReceipt?.gasUsed || 0n;
    
    console.log(`   ✅ ReverseRegistrar deployed: ${reverseAddress}`);
    console.log(`   ⛽ Gas used: ${reverseReceipt?.gasUsed}\n`);

    // 5. Deploy AuctionRegistrar
    console.log("5️⃣ Deploying AuctionRegistrar...");
    const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
    const auction = await AuctionFactory.deploy(registryAddress);
    await auction.waitForDeployment();
    const auctionAddress = await auction.getAddress();
    
    const auctionReceipt = await auction.deploymentTransaction()?.wait();
    deploymentResult.contracts.auctionRegistrar = auctionAddress;
    deploymentResult.gasUsed.auctionRegistrar = auctionReceipt?.gasUsed || 0n;
    
    console.log(`   ✅ AuctionRegistrar deployed: ${auctionAddress}`);
    console.log(`   ⛽ Gas used: ${auctionReceipt?.gasUsed}\n`);

    // 6. Deploy SubdomainRegistrar
    console.log("6️⃣ Deploying SubdomainRegistrar...");
    const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
    const subdomain = await SubdomainFactory.deploy(registryAddress, reverseAddress);
    await subdomain.waitForDeployment();
    const subdomainAddress = await subdomain.getAddress();
    
    const subdomainReceipt = await subdomain.deploymentTransaction()?.wait();
    deploymentResult.contracts.subdomainRegistrar = subdomainAddress;
    deploymentResult.gasUsed.subdomainRegistrar = subdomainReceipt?.gasUsed || 0n;
    
    console.log(`   ✅ SubdomainRegistrar deployed: ${subdomainAddress}`);
    console.log(`   ⛽ Gas used: ${subdomainReceipt?.gasUsed}\n`);

    // 7. Setup roles and connections
    console.log("7️⃣ Setting up roles and connections...");
    
    // Get role constants
    const registrarRole = await registry.REGISTRAR_ROLE();
    const registryRole = await reverse.REGISTRY_ROLE();
    const auctioneerRole = await auction.AUCTIONEER_ROLE();
    
    // Grant roles
    console.log("   🔐 Granting REGISTRAR_ROLE to AuctionRegistrar...");
    await registry.grantRole(registrarRole, auctionAddress);
    
    console.log("   🔐 Granting REGISTRAR_ROLE to SubdomainRegistrar...");
    await registry.grantRole(registrarRole, subdomainAddress);
    
    console.log("   🔐 Granting REGISTRY_ROLE to Registry in ReverseRegistrar...");
    await reverse.grantRole(registryRole, registryAddress);
    
    console.log("   🔐 Granting AUCTIONEER_ROLE to deployer...");
    await auction.grantRole(auctioneerRole, deployerAddress);
    
    // Connect reverse registrar
    console.log("   🔗 Connecting ReverseRegistrar to Registry...");
    await registry.setReverseRegistrar(reverseAddress);
    
    // Update resolver with registry
    console.log("   🔗 Setting default resolver in Registry...");
    await registry.setDefaultResolver(finalResolverAddress);
    
    console.log("   ✅ All roles and connections configured\n");

    // 8. Verify deployment
    console.log("8️⃣ Verifying deployment...");
    
    const TLD_NODE = await registry.TLD_NODE();
    const tldRecord = await registry.getRecord(TLD_NODE);
    
    console.log(`   🌐 TLD Node: ${TLD_NODE}`);
    console.log(`   👤 TLD Owner: ${tldRecord.owner}`);
    console.log(`   📝 TLD Resolver: ${tldRecord.resolver}`);
    console.log(`   ⏰ TLD Expiry: ${new Date(Number(tldRecord.expiry) * 1000).toISOString()}`);
    
    // Test basic functionality
    console.log("   🧪 Testing basic functionality...");
    const testPrice = await registry.priceOf("test");
    console.log(`   💰 Price for 'test': ${ethers.formatEther(testPrice)} ETH`);
    
    const renewalPrice = await registry.renewalPriceOf("test", 365 * 24 * 60 * 60);
    console.log(`   🔄 Renewal price for 'test' (1 year): ${ethers.formatEther(renewalPrice)} ETH`);
    
    console.log("   ✅ Deployment verification complete\n");

    // 9. Calculate total gas used and cost
    const finalBalance = await ethers.provider.getBalance(deployerAddress);
    const totalGasUsed = Object.values(deploymentResult.gasUsed).reduce((a, b) => a + b, 0n);
    const totalCost = initialBalance - finalBalance;
    
    console.log("💰 Deployment Summary:");
    console.log(`Total Gas Used: ${totalGasUsed.toLocaleString()}`);
    console.log(`Total Cost: ${ethers.formatEther(totalCost)} ETH`);
    console.log(`Remaining Balance: ${ethers.formatEther(finalBalance)} ETH\n`);

    // 10. Save deployment info
    const filename = `deployments/${network.name}-${Date.now()}.json`;
    writeFileSync(filename, JSON.stringify(deploymentResult, null, 2));
    console.log(`📄 Deployment info saved to: ${filename}\n`);

    // 11. Print summary
    console.log("🎉 GraphiteDNS System Deployment Complete!");
    console.log("=" .repeat(60));
    console.log(`Registry:           ${registryAddress}`);
    console.log(`Resolver:           ${finalResolverAddress}`);
    console.log(`ReverseRegistrar:   ${reverseAddress}`);
    console.log(`AuctionRegistrar:   ${auctionAddress}`);
    console.log(`SubdomainRegistrar: ${subdomainAddress}`);
    console.log("=" .repeat(60));

    // 12. Frontend integration instructions
    console.log("\n📱 Frontend Integration:");
    console.log("Add these addresses to your frontend configuration:");
    console.log(`
export const GRAPHITE_DNS_ADDRESSES = {
  registry: "${registryAddress}",
  resolver: "${finalResolverAddress}",
  reverseRegistrar: "${reverseAddress}",
  auctionRegistrar: "${auctionAddress}",
  subdomainRegistrar: "${subdomainAddress}"
};

export const NETWORK_CONFIG = {
  chainId: ${network.config.chainId || 'unknown'},
  name: "${network.name}",
  rpcUrl: "${network.config.url || 'unknown'}"
};
    `);

    // 13. Next steps
    console.log("🚀 Next Steps:");
    console.log("1. Verify contracts on block explorer");
    console.log("2. Update frontend with new contract addresses");
    console.log("3. Test domain registration flow");
    console.log("4. Set up monitoring and alerts");
    console.log("5. Configure pricing parameters if needed");
    
    if (network.name === "hardhat" || network.name === "localhost") {
      console.log("\n⚠️  Local Development Notes:");
      console.log("- Contracts deployed to local network");
      console.log("- Use these addresses for testing");
      console.log("- Remember to restart hardhat node to reset state");
    }

    return deploymentResult;

  } catch (error) {
    console.error("❌ Deployment failed:", error);
    
    // Save partial deployment info for debugging
    const errorFilename = `deployments/failed-${network.name}-${Date.now()}.json`;
    writeFileSync(errorFilename, JSON.stringify({
      ...deploymentResult,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Math.floor(Date.now() / 1000)
    }, null, 2));
    
    console.log(`🔍 Error details saved to: ${errorFilename}`);
    process.exit(1);
  }
}

// Additional utility functions for post-deployment setup
async function setupTestData(contracts: any) {
  console.log("🎭 Setting up test data...");
  
  // Set custom prices for popular names
  const popularNames = ["alice", "bob", "charlie", "test", "demo"];
  for (const name of popularNames) {
    const node = ethers.keccak256(
      ethers.solidityPacked(["bytes32", "bytes32"], 
      [await contracts.registry.TLD_NODE(), ethers.keccak256(ethers.toUtf8Bytes(name))])
    );
    await contracts.registry.setCustomPrice(node, ethers.parseEther("0.1"));
    console.log(`   💰 Set custom price for '${name}': 0.1 ETH`);
  }
  
  // Start some sample auctions
  const auctionNames = ["premium", "gold", "diamond"];
  for (const name of auctionNames) {
    await contracts.auction.startAuction(
      name,
      3600, // 1 hour commit
      3600, // 1 hour reveal  
      ethers.parseEther("1") // 1 ETH minimum bid
    );
    console.log(`   🏆 Started auction for '${name}'`);
  }
  
  console.log("   ✅ Test data setup complete\n");
}

async function verifyContracts(deploymentResult: DeploymentResult) {
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("⏭️  Skipping verification for local network\n");
    return;
  }
  
  console.log("🔍 Verifying contracts on block explorer...");
  
  try {
    const { run } = require("hardhat");
    
    // Verify each contract
    for (const [name, address] of Object.entries(deploymentResult.contracts)) {
      console.log(`   📋 Verifying ${name} at ${address}...`);
      
      try {
        await run("verify:verify", {
          address: address,
          constructorArguments: getConstructorArgs(name, deploymentResult)
        });
        console.log(`   ✅ ${name} verified`);
      } catch (error) {
        console.log(`   ⚠️  ${name} verification failed:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.log("   ❌ Verification setup failed:", error);
  }
  
  console.log("   🔍 Verification process completed\n");
}

function getConstructorArgs(contractName: string, deployment: DeploymentResult): any[] {
  switch (contractName) {
    case "registry":
      return [deployment.contracts.resolver, "atgraphite"];
    case "resolver":
      return [deployment.contracts.registry];
    case "reverseRegistrar":
      return [deployment.contracts.registry];
    case "auctionRegistrar":
      return [deployment.contracts.registry];
    case "subdomainRegistrar":
      return [deployment.contracts.registry, deployment.contracts.reverseRegistrar];
    default:
      return [];
  }
}

// Run deployment
if (require.main === module) {
  main()
    .then(async (result) => {
      if (process.env.SETUP_TEST_DATA === "true") {
        // Get contract instances for test data setup
        const registry = await ethers.getContractAt("GraphiteDNSRegistry", result.contracts.registry);
        const auction = await ethers.getContractAt("AuctionRegistrar", result.contracts.auctionRegistrar);
        
        await setupTestData({ registry, auction });
      }
      
      if (process.env.VERIFY_CONTRACTS === "true") {
        await verifyContracts(result);
      }
      
      console.log("🏁 All deployment tasks completed!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Fatal error:", error);
      process.exit(1);
    });
}
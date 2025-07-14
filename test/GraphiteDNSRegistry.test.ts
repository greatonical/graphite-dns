import { expect } from "chai";
import { ethers } from "hardhat";

describe("GraphiteDNSRegistry - Fixed Version", function () {
  let registry: any;
  let resolver: any;
  let owner: any;
  let addr1: any;
  let addr2: any;
  let addr3: any;

  const oneYear = 365 * 24 * 3600;
  const twoYears = 2 * oneYear;
  const threeYears = 3 * oneYear;

  beforeEach(async function () {
    [owner, addr1, addr2, addr3] = await ethers.getSigners();

    // Deploy resolver first (with zero address temporarily)
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    resolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    await resolver.waitForDeployment();

    // Deploy registry with resolver
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await resolver.getAddress());
    await registry.waitForDeployment();

    // Deploy final resolver with registry address
    const finalResolver = await ResolverFactory.deploy(await registry.getAddress());
    await finalResolver.waitForDeployment();
    resolver = finalResolver;
  });

  describe("Deployment", function () {
    it("Should set the correct admin roles", async function () {
      const adminRole = await registry.DEFAULT_ADMIN_ROLE();
      expect(await registry.hasRole(adminRole, owner.address)).to.be.true;
    });

    it("Should bootstrap .atgraphite TLD", async function () {
      const tldNode = await registry.TLD_NODE();
      const domain = await registry.getDomain(tldNode);
      expect(domain.owner).to.equal(await registry.getAddress());
      // Check for uint64 max value instead of uint256 max
      expect(domain.expiry).to.equal(18446744073709551615n); // type(uint64).max
    });

    it("Should set correct initial duration multipliers", async function () {
      expect(await registry.durationMultipliers(1)).to.equal(10000); // 100%
      expect(await registry.durationMultipliers(2)).to.equal(9500);  // 95%
      expect(await registry.durationMultipliers(3)).to.equal(9000);  // 90%
    });
  });

  describe("Duration-Based Pricing", function () {
    it("Should calculate correct price for different durations", async function () {
      const basePrice = await registry["priceOf(string,uint64)"]("test", oneYear);
      const twoYearPrice = await registry["priceOf(string,uint64)"]("test", twoYears);
      const threeYearPrice = await registry["priceOf(string,uint64)"]("test", threeYears);

      // 2 years should be 2 * 95% = 1.9x base price
      expect(twoYearPrice).to.equal(basePrice * 2n * 9500n / 10000n);
      
      // 3 years should be 3 * 90% = 2.7x base price
      expect(threeYearPrice).to.equal(basePrice * 3n * 9000n / 10000n);
    });

    it("Should allow admin to set duration multipliers", async function () {
      await registry.setDurationMultiplier(5, 8000); // 5 years = 80%
      expect(await registry.durationMultipliers(5)).to.equal(8000);

      const basePrice = await registry["priceOf(string,uint64)"]("test", oneYear);
      const fiveYearPrice = await registry["priceOf(string,uint64)"]("test", 5 * oneYear);
      expect(fiveYearPrice).to.equal(basePrice * 5n * 8000n / 10000n);
    });

    it("Should revert on invalid multipliers", async function () {
      await expect(
        registry.setDurationMultiplier(1, 0)
      ).to.be.revertedWith("Invalid multiplier");

      await expect(
        registry.setDurationMultiplier(1, 25000) // > 200%
      ).to.be.revertedWith("Invalid multiplier");
    });

    it("Should support legacy single-parameter priceOf", async function () {
      const legacyPrice = await registry["priceOf(string)"]("test");
      const modernPrice = await registry["priceOf(string,uint64)"]("test", oneYear);
      
      expect(legacyPrice).to.equal(modernPrice);
    });
  });

  describe("Domain Registration", function () {
    it("Should register domain with correct duration pricing", async function () {
      const price = await registry["priceOf(string,uint64)"]("alice", twoYears);
      
      await expect(
        registry.connect(addr1).buyFixedPrice("alice", await resolver.getAddress(), twoYears, { value: price })
      ).to.emit(registry, "DomainRegistered")
       .and.to.emit(registry, "NamePurchased");

      const tokenId = 1n;
      expect(await registry.ownerOf(tokenId)).to.equal(addr1.address);
      
      // Check domain mapping
      const node = await registry.getNodeOfToken(tokenId);
      const domain = await registry.getDomain(node);
      expect(domain.owner).to.equal(addr1.address);
      expect(domain.expiry).to.be.closeTo(
        BigInt(Math.floor(Date.now() / 1000)) + BigInt(twoYears),
        100n
      );
    });

    it("Should refund overpayment", async function () {
      const price = await registry["priceOf(string,uint64)"]("bob", oneYear);
      const overpayment = ethers.parseEther("1.0");
      const totalPayment = price + overpayment;

      const balanceBefore = await ethers.provider.getBalance(addr1.address);
      
      const tx = await registry.connect(addr1).buyFixedPrice(
        "bob", 
        await resolver.getAddress(), 
        oneYear, 
        { value: totalPayment }
      );
      
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(addr1.address);

      // Should only pay the actual price + gas
      expect(balanceBefore - balanceAfter).to.equal(price + gasUsed);
    });

    it("Should reject insufficient payment", async function () {
      const price = await registry["priceOf(string,uint64)"]("charlie", oneYear);
      
      await expect(
        registry.connect(addr1).buyFixedPrice(
          "charlie", 
          await resolver.getAddress(), 
          oneYear, 
          { value: price - 1n }
        )
      ).to.be.revertedWith("Insufficient payment");
    });

    it("Should prevent registration of unavailable domains", async function () {
      const price = await registry["priceOf(string,uint64)"]("taken", oneYear);
      
      // First registration should succeed
      await registry.connect(addr1).buyFixedPrice(
        "taken", 
        await resolver.getAddress(), 
        oneYear, 
        { value: price }
      );

      // Second registration should fail
      await expect(
        registry.connect(addr2).buyFixedPrice(
          "taken", 
          await resolver.getAddress(), 
          oneYear, 
          { value: price }
        )
      ).to.be.revertedWith("Domain not available");
    });

    it("Should validate domain names", async function () {
      const price = await registry["priceOf(string,uint64)"]("valid", oneYear);
      
      // Valid domain should work
      await registry.connect(addr1).buyFixedPrice(
        "valid123", 
        await resolver.getAddress(), 
        oneYear, 
        { value: price }
      );

      // Invalid characters should fail (this would happen in _validateLabel)
      await expect(
        registry.connect(addr1).buyFixedPrice(
          "", // empty string
          await resolver.getAddress(), 
          oneYear, 
          { value: price }
        )
      ).to.be.reverted;
    });
  });

  describe("NFT Transfer Integration", function () {
    let tokenId: bigint;
    let node: string;

    beforeEach(async function () {
      const price = await registry["priceOf(string,uint64)"]("nfttest", oneYear);
      await registry.connect(addr1).buyFixedPrice(
        "nfttest", 
        await resolver.getAddress(), 
        oneYear, 
        { value: price }
      );
      tokenId = 1n;
      node = await registry.getNodeOfToken(tokenId);
    });

    it("Should update domain ownership when NFT is transferred", async function () {
      // Transfer NFT
      await expect(
        registry.connect(addr1).transferFrom(addr1.address, addr2.address, tokenId)
      ).to.emit(registry, "DomainTransferred")
       .withArgs(node, addr1.address, addr2.address);

      // Check domain ownership updated
      const domain = await registry.getDomain(node);
      expect(domain.owner).to.equal(addr2.address);
      
      // Check NFT ownership
      expect(await registry.ownerOf(tokenId)).to.equal(addr2.address);
    });

    it("Should maintain bidirectional token-node mapping", async function () {
      expect(await registry.getNodeOfToken(tokenId)).to.equal(node);
      expect(await registry.getTokenOfNode(node)).to.equal(tokenId);
    });

    it("Should work with marketplace transfers", async function () {
      // Approve marketplace (simulated by addr3)
      await registry.connect(addr1).approve(addr3.address, tokenId);
      
      // Marketplace transfers on behalf of user
      await registry.connect(addr3).transferFrom(addr1.address, addr2.address, tokenId);
      
      // Verify ownership transfer
      const domain = await registry.getDomain(node);
      expect(domain.owner).to.equal(addr2.address);
      expect(await registry.ownerOf(tokenId)).to.equal(addr2.address);
    });
  });

  describe("Meta-Transactions", function () {
    it("Should allow meta-transfer with valid signature", async function () {
      // Register domain
      const price = await registry["priceOf(string,uint64)"]("metatest", oneYear);
      await registry.connect(addr1).buyFixedPrice(
        "metatest", 
        await resolver.getAddress(), 
        oneYear, 
        { value: price }
      );

      const node = await registry.getNodeOfToken(1n);
      const nonce = 1n;
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n; // 1 hour from now

      // Get current block timestamp and add buffer
      const latestBlock = await ethers.provider.getBlock('latest');
      const safeDeadline = BigInt(latestBlock!.timestamp) + 3600n;

      // Create signature (simplified - in real implementation you'd use proper EIP-712 signing)
      const domain = {
        name: "GraphiteDNS",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await registry.getAddress()
      };

      const types = {
        Transfer: [
          { name: "node", type: "bytes32" },
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const value = {
        node: node,
        from: addr1.address,
        to: addr2.address,
        nonce: nonce,
        deadline: safeDeadline
      };

      const signature = await addr1.signTypedData(domain, types, value);

      // Execute meta-transfer
      await expect(
        registry.transferWithSig(node, addr1.address, addr2.address, nonce, safeDeadline, signature)
      ).to.emit(registry, "DomainTransferred");

      // Verify transfer
      expect(await registry.ownerOf(1n)).to.equal(addr2.address);
    });

    it("Should reject expired signatures", async function () {
      const price = await registry["priceOf(string,uint64)"]("expired", oneYear);
      await registry.connect(addr1).buyFixedPrice(
        "expired", 
        await resolver.getAddress(), 
        oneYear, 
        { value: price }
      );

      const node = await registry.getNodeOfToken(2n);
      const pastDeadline = BigInt(Math.floor(Date.now() / 1000)) - 3600n; // 1 hour ago

      await expect(
        registry.transferWithSig(node, addr1.address, addr2.address, 1n, pastDeadline, "0x00")
      ).to.be.revertedWith("Signature expired");
    });
  });

  describe("Fixed Price Management", function () {
    it("Should allow admin to set fixed prices", async function () {
      await registry.setFixedPrice("premium", ethers.parseEther("10.0"));
      
      const price = await registry["priceOf(string,uint64)"]("premium", oneYear);
      expect(price).to.equal(ethers.parseEther("10.0"));
    });

    it("Should apply duration pricing to fixed prices", async function () {
      await registry.setFixedPrice("premium", ethers.parseEther("1.0"));
      
      const oneYearPrice = await registry["priceOf(string,uint64)"]("premium", oneYear);
      const twoYearPrice = await registry["priceOf(string,uint64)"]("premium", twoYears);
      
      expect(oneYearPrice).to.equal(ethers.parseEther("1.0"));
      expect(twoYearPrice).to.equal(ethers.parseEther("1.9")); // 2 * 95%
    });

    it("Should allow purchasing fixed price domains", async function () {
      await registry.setFixedPrice("expensive", ethers.parseEther("5.0"));
      const price = await registry["priceOf(string,uint64)"]("expensive", oneYear);
      
      await registry.connect(addr1).buyFixedPrice(
        "expensive",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );

      expect(await registry.ownerOf(3n)).to.equal(addr1.address);
    });
  });

  describe("Access Control", function () {
    it("Should restrict admin functions to admin role", async function () {
      await expect(
        registry.connect(addr1).setFixedPrice("test", ethers.parseEther("1.0"))
      ).to.be.reverted;

      await expect(
        registry.connect(addr1).setDurationMultiplier(5, 8000)
      ).to.be.reverted;
    });

    it("Should allow role delegation", async function () {
      const registrarRole = await registry.REGISTRAR_ROLE();
      await registry.grantRole(registrarRole, addr1.address);

      expect(await registry.hasRole(registrarRole, addr1.address)).to.be.true;
    });

    it("Should allow admin to register domains directly", async function () {
      await expect(
        registry.register(
          "admin",
          addr1.address,
          oneYear,
          await resolver.getAddress(),
          await registry.TLD_NODE()
        )
      ).to.emit(registry, "DomainRegistered");
    });

    it("Should restrict direct registration to REGISTRAR_ROLE", async function () {
      await expect(
        registry.connect(addr1).register(
          "unauthorized",
          addr1.address,
          oneYear,
          await resolver.getAddress(),
          await registry.TLD_NODE()
        )
      ).to.be.reverted;
    });
  });

  describe("Emergency Functions", function () {
    it("Should allow pausing and unpausing", async function () {
      await registry.pause();
      expect(await registry.paused()).to.be.true;

      const price = await registry["priceOf(string,uint64)"]("test", oneYear);
      await expect(
        registry.connect(addr1).buyFixedPrice(
          "test", 
          await resolver.getAddress(), 
          oneYear, 
          { value: price }
        )
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");

      await registry.unpause();
      expect(await registry.paused()).to.be.false;
      
      // Should work after unpause
      await registry.connect(addr1).buyFixedPrice(
        "test", 
        await resolver.getAddress(), 
        oneYear, 
        { value: price }
      );
    });

    it("Should allow emergency withdrawal", async function () {
      // Add some funds to contract
      const price = await registry["priceOf(string,uint64)"]("test", oneYear);
      await registry.connect(addr1).buyFixedPrice(
        "test", 
        await resolver.getAddress(), 
        oneYear, 
        { value: price }
      );

      const contractBalance = await ethers.provider.getBalance(await registry.getAddress());
      expect(contractBalance).to.be.gt(0);

      const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);
      await registry.withdraw();
      const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);

      expect(ownerBalanceAfter).to.be.gt(ownerBalanceBefore);
    });

    it("Should restrict emergency functions to admin", async function () {
      await expect(
        registry.connect(addr1).pause()
      ).to.be.reverted;

      await expect(
        registry.connect(addr1).withdraw()
      ).to.be.reverted;
    });
  });

  describe("Domain Lifecycle", function () {
    it("Should handle domain expiry correctly", async function () {
      const price = await registry["priceOf(string,uint64)"]("expiry", oneYear);
      await registry.connect(addr1).buyFixedPrice(
        "expiry",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );

      const node = await registry.getNodeOfToken(1n);
      const domain = await registry.getDomain(node);
      
      // Should not be available immediately after registration
      expect(await registry.isAvailable(node)).to.be.false;
      
      // Domain should still have valid expiry
      expect(domain.expiry).to.be.gt(BigInt(Math.floor(Date.now() / 1000)));
    });

    it("Should handle grace period", async function () {
      // Test requires time manipulation which is complex in this test
      // This is a placeholder for grace period testing
      expect(await registry.gracePeriod()).to.equal(90 * 24 * 3600); // 90 days
    });
  });

  describe("Gas Efficiency", function () {
    it("Should register domains efficiently", async function () {
      const price = await registry["priceOf(string,uint64)"]("gastest", oneYear);
      
      const tx = await registry.connect(addr1).buyFixedPrice(
        "gastest",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );
      
      const receipt = await tx.wait();
      console.log(`Domain registration gas: ${receipt!.gasUsed}`);
      
      // Should be reasonable gas usage
      expect(receipt!.gasUsed).to.be.lt(300000n);
    });

    it("Should transfer NFTs efficiently", async function () {
      const price = await registry["priceOf(string,uint64)"]("transfer", oneYear);
      await registry.connect(addr1).buyFixedPrice(
        "transfer",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );

      const tokenId = 2n;
      const tx = await registry.connect(addr1).transferFrom(
        addr1.address,
        addr2.address,
        tokenId
      );
      
      const receipt = await tx.wait();
      console.log(`NFT transfer gas: ${receipt!.gasUsed}`);
      
      // Should be reasonable gas usage
      expect(receipt!.gasUsed).to.be.lt(100000n);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle maximum duration", async function () {
      const maxDuration = await registry.maxRegistration();
      const price = await registry["priceOf(string,uint64)"]("maxduration", Number(maxDuration));
      
      await registry.connect(addr1).buyFixedPrice(
        "maxduration",
        await resolver.getAddress(),
        Number(maxDuration),
        { value: price }
      );

      expect(await registry.ownerOf(1n)).to.equal(addr1.address);
    });

    it("Should reject duration beyond maximum", async function () {
      const maxDuration = await registry.maxRegistration();
      const price = await registry["priceOf(string,uint64)"]("toolong", oneYear);
      
      await expect(
        registry.connect(addr1).buyFixedPrice(
          "toolong",
          await resolver.getAddress(),
          Number(maxDuration) + 1,
          { value: price }
        )
      ).to.be.revertedWith("Duration too long");
    });

    it("Should handle minimum valid domain names", async function () {
      const price = await registry["priceOf(string,uint64)"]("a", oneYear);
      
      await registry.connect(addr1).buyFixedPrice(
        "a",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );

      expect(await registry.ownerOf(1n)).to.equal(addr1.address);
    });
  });
});
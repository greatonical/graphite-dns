import { expect } from "chai";
import { ethers } from "hardhat";
import type { GraphiteDNSRegistry, GraphiteResolver, SubdomainRegistrar } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("SubdomainRegistrar - Fixed Version", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let subdomain: SubdomainRegistrar;
  let owner: SignerWithAddress;
  let parentOwner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let beneficiary: SignerWithAddress;

  const oneYear = 365 * 24 * 3600;
  let parentNode: string;

  beforeEach(async function () {
    [owner, parentOwner, buyer, beneficiary] = await ethers.getSigners();

    // Deploy resolver
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const tempResolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await tempResolver.getAddress());
    
    // Deploy final resolver
    resolver = await ResolverFactory.deploy(await registry.getAddress());
    
    // Deploy subdomain registrar
    const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
    subdomain = await SubdomainFactory.deploy(await registry.getAddress());

    // Grant REGISTRAR_ROLE to subdomain contract
    const registrarRole = await registry.REGISTRAR_ROLE();
    await registry.grantRole(registrarRole, await subdomain.getAddress());

    // Register parent domain
    const price = await registry["priceOf(string,uint64)"]("parent", oneYear);
    await registry.connect(parentOwner).buyFixedPrice(
      "parent",
      await resolver.getAddress(),
      oneYear,
      { value: price }
    );

    const tokenId = await registry.getTokenOfNode(
      await registry.getNodeOfLabel("parent")
    );
    parentNode = await registry.getNodeOfToken(tokenId);
  });

  describe("Subdomain Configuration", function () {
    it("Should allow parent owner to configure subdomain", async function () {
      await expect(
        subdomain.connect(parentOwner).configureSubdomain(
          parentNode,
          "blog",
          ethers.parseEther("0.1"),
          true, // allow public registration
          oneYear,
          beneficiary.address
        )
      ).to.emit(subdomain, "SubdomainConfigured");

      const config = await subdomain.getSubdomainConfig(parentNode, "blog");
      expect(config.price).to.equal(ethers.parseEther("0.1"));
      expect(config.allowPublicRegistration).to.be.true;
      expect(config.maxDuration).to.equal(oneYear);
      expect(config.beneficiary).to.equal(beneficiary.address);
    });

    it("Should reject configuration from non-parent owner", async function () {
      await expect(
        subdomain.connect(buyer).configureSubdomain(
          parentNode,
          "blog",
          ethers.parseEther("0.1"),
          true,
          oneYear,
          beneficiary.address
        )
      ).to.be.revertedWith("Not parent owner");
    });

    it("Should set default beneficiary to parent owner if zero address", async function () {
      await subdomain.connect(parentOwner).configureSubdomain(
        parentNode,
        "blog",
        ethers.parseEther("0.1"),
        true,
        oneYear,
        ethers.ZeroAddress // Should default to parent owner
      );

      const config = await subdomain.getSubdomainConfig(parentNode, "blog");
      expect(config.beneficiary).to.equal(parentOwner.address);
    });

    it("Should allow parent owner to enable/disable registration", async function () {
      await subdomain.connect(parentOwner).setSubdomainRegistrationEnabled(parentNode, true);
      expect(await subdomain.subdomainRegistrationEnabled(parentNode)).to.be.true;

      await subdomain.connect(parentOwner).setSubdomainRegistrationEnabled(parentNode, false);
      expect(await subdomain.subdomainRegistrationEnabled(parentNode)).to.be.false;
    });
  });

  describe("Duration-Based Pricing", function () {
    beforeEach(async function () {
      await subdomain.connect(parentOwner).configureSubdomain(
        parentNode,
        "shop",
        ethers.parseEther("0.1"), // 0.1 ETH per year
        true,
        5 * oneYear, // max 5 years
        beneficiary.address
      );
      await subdomain.connect(parentOwner).setSubdomainRegistrationEnabled(parentNode, true);
    });

    it("Should calculate price based on duration", async function () {
      const oneYearPrice = await subdomain.priceOfSubdomain(parentNode, "shop", oneYear);
      const twoYearPrice = await subdomain.priceOfSubdomain(parentNode, "shop", 2 * oneYear);
      const threeYearPrice = await subdomain.priceOfSubdomain(parentNode, "shop", 3 * oneYear);

      expect(oneYearPrice).to.equal(ethers.parseEther("0.1"));
      expect(twoYearPrice).to.equal(ethers.parseEther("0.2"));
      expect(threeYearPrice).to.equal(ethers.parseEther("0.3"));
    });

    it("Should handle free subdomains", async function () {
      await subdomain.connect(parentOwner).configureSubdomain(
        parentNode,
        "free",
        0, // Free
        true,
        oneYear,
        beneficiary.address
      );

      const price = await subdomain.priceOfSubdomain(parentNode, "free", oneYear);
      expect(price).to.equal(0);
    });
  });

  describe("Public Subdomain Registration", function () {
    beforeEach(async function () {
      await subdomain.connect(parentOwner).configureSubdomain(
        parentNode,
        "public",
        ethers.parseEther("0.05"),
        true, // public
        2 * oneYear,
        beneficiary.address
      );
      await subdomain.connect(parentOwner).setSubdomainRegistrationEnabled(parentNode, true);
    });

    it("Should allow public registration of configured subdomain", async function () {
      const price = await subdomain.priceOfSubdomain(parentNode, "public", oneYear);
      
      await expect(
        subdomain.connect(buyer).buySubdomain(
          parentNode,
          "public",
          oneYear,
          await resolver.getAddress(),
          { value: price }
        )
      ).to.emit(subdomain, "SubdomainRegistered");

      // Verify registration
      const subdomainNode = ethers.keccak256(
        ethers.concat([parentNode, ethers.keccak256(ethers.toUtf8Bytes("public"))])
      );
      const domain = await registry.getDomain(subdomainNode);
      expect(domain.owner).to.equal(buyer.address);
    });

    it("Should route payment to beneficiary", async function () {
      const price = await subdomain.priceOfSubdomain(parentNode, "public", oneYear);
      const beneficiaryBalanceBefore = await ethers.provider.getBalance(beneficiary.address);

      await subdomain.connect(buyer).buySubdomain(
        parentNode,
        "public",
        oneYear,
        await resolver.getAddress(),
        { value: price }
      );

      const beneficiaryBalanceAfter = await ethers.provider.getBalance(beneficiary.address);
      expect(beneficiaryBalanceAfter - beneficiaryBalanceBefore).to.equal(price);
    });

    it("Should refund overpayment", async function () {
      const price = await subdomain.priceOfSubdomain(parentNode, "public", oneYear);
      const overpayment = ethers.parseEther("1.0");
      const totalPayment = price + overpayment;

      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);
      
      const tx = await subdomain.connect(buyer).buySubdomain(
        parentNode,
        "public",
        oneYear,
        await resolver.getAddress(),
        { value: totalPayment }
      );

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);

      // Should only pay the actual price + gas
      expect(buyerBalanceBefore - buyerBalanceAfter).to.equal(price + gasUsed);
    });

    it("Should reject registration when disabled", async function () {
      await subdomain.connect(parentOwner).setSubdomainRegistrationEnabled(parentNode, false);
      
      const price = await subdomain.priceOfSubdomain(parentNode, "public", oneYear);
      
      await expect(
        subdomain.connect(buyer).buySubdomain(
          parentNode,
          "public",
          oneYear,
          await resolver.getAddress(),
          { value: price }
        )
      ).to.be.revertedWith("Registration disabled");
    });

    it("Should reject private subdomain registration", async function () {
      await subdomain.connect(parentOwner).configureSubdomain(
        parentNode,
        "private",
        ethers.parseEther("0.1"),
        false, // private
        oneYear,
        beneficiary.address
      );

      const price = await subdomain.priceOfSubdomain(parentNode, "private", oneYear);
      
      await expect(
        subdomain.connect(buyer).buySubdomain(
          parentNode,
          "private",
          oneYear,
          await resolver.getAddress(),
          { value: price }
        )
      ).to.be.revertedWith("Private subdomain");
    });

    it("Should enforce max duration", async function () {
      const price = await subdomain.priceOfSubdomain(parentNode, "public", 3 * oneYear);
      
      await expect(
        subdomain.connect(buyer).buySubdomain(
          parentNode,
          "public",
          3 * oneYear, // exceeds max of 2 years
          await resolver.getAddress(),
          { value: price }
        )
      ).to.be.revertedWith("Duration too long");
    });
  });

  describe("Parent Owner Direct Registration", function () {
    it("Should allow parent owner to register subdomain for any user", async function () {
      await expect(
        subdomain.connect(parentOwner).registerSubdomainForUser(
          parentNode,
          "direct",
          buyer.address,
          oneYear,
          await resolver.getAddress()
        )
      ).to.emit(subdomain, "SubdomainRegistered");

      const subdomainNode = ethers.keccak256(
        ethers.concat([parentNode, ethers.keccak256(ethers.toUtf8Bytes("direct"))])
      );
      const domain = await registry.getDomain(subdomainNode);
      expect(domain.owner).to.equal(buyer.address);
    });

    it("Should reject direct registration from non-parent owner", async function () {
      await expect(
        subdomain.connect(buyer).registerSubdomainForUser(
          parentNode,
          "direct",
          buyer.address,
          oneYear,
          await resolver.getAddress()
        )
      ).to.be.revertedWith("Not parent owner");
    });
  });

  describe("Legacy Compatibility", function () {
    it("Should support legacy setSubdomainPrice function", async function () {
      await subdomain.connect(parentOwner).setSubdomainPrice(
        parentNode,
        "legacy",
        ethers.parseEther("0.2")
      );

      const config = await subdomain.getSubdomainConfig(parentNode, "legacy");
      expect(config.price).to.equal(ethers.parseEther("0.2"));
      expect(config.allowPublicRegistration).to.be.true;
      expect(config.beneficiary).to.equal(parentOwner.address);
      expect(await subdomain.subdomainRegistrationEnabled(parentNode)).to.be.true;
    });

    it("Should support legacy buySubdomainFixedPrice function", async function () {
      await subdomain.connect(parentOwner).setSubdomainPrice(
        parentNode,
        "legacy",
        ethers.parseEther("0.1")
      );

      const price = await subdomain.priceOfSubdomain(parentNode, "legacy", oneYear);
      
      await expect(
        subdomain.connect(buyer).buySubdomainFixedPrice(
          parentNode,
          "legacy",
          await resolver.getAddress(),
          oneYear,
          { value: price }
        )
      ).to.emit(subdomain, "SubdomainRegistered");
    });
  });

  describe("Access Control and Security", function () {
    it("Should validate parent domain exists and not expired", async function () {
      // Try with non-existent parent
      const fakeParentNode = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      
      await expect(
        subdomain.connect(parentOwner).registerSubdomainForUser(
          fakeParentNode,
          "test",
          buyer.address,
          oneYear,
          await resolver.getAddress()
        )
      ).to.be.revertedWith("Parent doesn't exist");
    });

    it("Should handle insufficient payment", async function () {
      await subdomain.connect(parentOwner).configureSubdomain(
        parentNode,
        "expensive",
        ethers.parseEther("1.0"),
        true,
        oneYear,
        beneficiary.address
      );
      await subdomain.connect(parentOwner).setSubdomainRegistrationEnabled(parentNode, true);

      const price = await subdomain.priceOfSubdomain(parentNode, "expensive", oneYear);
      
      await expect(
        subdomain.connect(buyer).buySubdomain(
          parentNode,
          "expensive",
          oneYear,
          await resolver.getAddress(),
          { value: price - 1n }
        )
      ).to.be.revertedWith("Insufficient payment");
    });

    it("Should handle pausing", async function () {
      await subdomain.pause();
      
      await expect(
        subdomain.connect(parentOwner).configureSubdomain(
          parentNode,
          "test",
          ethers.parseEther("0.1"),
          true,
          oneYear,
          beneficiary.address
        )
      ).to.be.revertedWith("Pausable: paused");
    });
  });
});
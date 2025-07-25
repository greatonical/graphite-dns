// test/GraphiteDNSRegistry.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { GraphiteDNSRegistry, GraphiteResolver } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GraphiteDNSRegistry", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const oneYear = 365 * 24 * 3600;

  beforeEach(async () => {
    [owner, user1, user2] = await ethers.getSigners();

    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    resolver = await ResolverFactory.deploy(ethers.ZeroAddress);

    const RegistryFactory = await ethers.getContractFactory(
      "GraphiteDNSRegistry"
    );
    registry = await RegistryFactory.deploy(await resolver.getAddress());

    resolver = await ResolverFactory.deploy(await registry.getAddress());
  });

  describe("Deployment & TLD Bootstrap", () => {
    it("Should bootstrap .atgraphite TLD correctly", async () => {
      const tldNode = await registry.TLD_NODE();
      const domain = await registry.getDomain(tldNode);

      expect(domain.owner).to.equal(owner.address);
      expect(domain.expiry).to.equal(ethers.MaxUint256 & ((1n << 64n) - 1n));
      expect(await registry.getLabel(tldNode)).to.equal("atgraphite");
    });
  });

  describe("Domain Registration", () => {
    it("Should register domain with correct ownership", async () => {
      const tx = await registry.register(
        "alice",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        await registry.TLD_NODE()
      );

      await expect(tx).to.emit(registry, "DomainRegistered");

      const node = ethers.keccak256(
        ethers.concat([
          await registry.TLD_NODE(),
          ethers.keccak256(ethers.toUtf8Bytes("alice")),
        ])
      );

      const domain = await registry.getDomain(node);
      expect(domain.owner).to.equal(user1.address);
    });

    it("Should prevent duplicate registrations", async () => {
      await registry.register(
        "bob",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        await registry.TLD_NODE()
      );

      await expect(
        registry.register(
          "bob",
          user2.address,
          oneYear,
          await resolver.getAddress(),
          await registry.TLD_NODE()
        )
      ).to.be.revertedWith("Domain not available");
    });
  });

  describe("Fixed Price Registration", () => {
    it("Should handle fixed price registration with refunds", async () => {
      const price = ethers.parseEther("1.0");
      const overpay = ethers.parseEther("2.0");

      await registry.setFixedPrice("premium", price);

      const balanceBefore = await ethers.provider.getBalance(user1.address);

      const tx = await registry
        .connect(user1)
        .buyFixedPrice("premium", await resolver.getAddress(), oneYear, {
          value: overpay,
        });

      const receipt = await tx.wait();

      const gasUsed = BigInt(receipt!.gasUsed) * BigInt(receipt!.gasPrice);
      const balanceAfter = await ethers.provider.getBalance(user1.address);

      expect(balanceBefore - balanceAfter - gasUsed).to.equal(price);
    });
  });

  describe("Domain Renewal", () => {
    let node: string;

    beforeEach(async () => {
      await registry.register(
        "renewable",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        await registry.TLD_NODE()
      );

      node = ethers.keccak256(
        ethers.concat([
          await registry.TLD_NODE(),
          ethers.keccak256(ethers.toUtf8Bytes("renewable")),
        ])
      );
    });

    it("Should allow owner to renew domain", async () => {
      const renewalDuration = oneYear;
      const domainBefore = await registry.getDomain(node);

      const renewalCost = await registry.priceOf("renewable");
      const actualCost =
        (renewalCost * BigInt(renewalDuration)) / BigInt(365 * 24 * 3600);
      await registry.connect(user1).renew(node, renewalDuration, {
        value: actualCost,
      });

      const domainAfter = await registry.getDomain(node);
      expect(domainAfter.expiry).to.equal(
        domainBefore.expiry + BigInt(renewalDuration)
      );
    });
  });

  describe("Expiry & Grace Period", () => {
    it("Should enforce expiry correctly", async () => {
      await registry.register(
        "shortlived",
        user1.address,
        1,
        await resolver.getAddress(),
        await registry.TLD_NODE()
      );

      const node = ethers.keccak256(
        ethers.concat([
          await registry.TLD_NODE(),
          ethers.keccak256(ethers.toUtf8Bytes("shortlived")),
        ])
      );

      await ethers.provider.send("evm_increaseTime", [2]);
      await ethers.provider.send("evm_mine", []);

      expect(await registry.isExpired(node)).to.be.true;
      expect(await registry.isInGracePeriod(node)).to.be.true;
    });
  });
});

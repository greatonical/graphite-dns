// test/SubdomainRegistrar.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { GraphiteDNSRegistry, GraphiteResolver, SubdomainRegistrar } from "../typechain";

describe("SubdomainRegistrar", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let subdomainRegistrar: SubdomainRegistrar;
  let parentOwner: any;
  let buyer: any;
  let parentNode: string;

  beforeEach(async () => {
    [, parentOwner, buyer] = await ethers.getSigners();

    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    resolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await resolver.getAddress());
    
    resolver = await ResolverFactory.deploy(await registry.getAddress());
    
    const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
    subdomainRegistrar = await SubdomainFactory.deploy(await registry.getAddress());

    const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REGISTRAR_ROLE"));
    await registry.grantRole(REGISTRAR_ROLE, await subdomainRegistrar.getAddress());

    await registry.register(
      "parent",
      parentOwner.address,
      365 * 24 * 3600,
      await resolver.getAddress(),
      await registry.TLD_NODE()
    );

    parentNode = ethers.keccak256(
      ethers.concat([
        await registry.TLD_NODE(),
        ethers.keccak256(ethers.toUtf8Bytes("parent"))
      ])
    );
  });

  describe("Subdomain Configuration", () => {
    it("Should allow parent owner to configure subdomains", async () => {
      await expect(
        subdomainRegistrar.connect(parentOwner).configureSubdomain(
          parentNode,
          "sub",
          ethers.parseEther("0.1"),
          true
        )
      ).to.emit(subdomainRegistrar, "SubdomainConfigured");
    });
  });

  describe("Subdomain Registration", () => {
    beforeEach(async () => {
      await subdomainRegistrar.connect(parentOwner).configureSubdomain(
        parentNode,
        "sale",
        ethers.parseEther("0.1"),
        true
      );
    });

    it("Should register subdomain with ownership transfer", async () => {
      await subdomainRegistrar.connect(buyer).registerSubdomain(
        parentNode,
        "sale",
        buyer.address,
        await resolver.getAddress(),
        365 * 24 * 3600,
        { value: ethers.parseEther("0.1") }
      );

      const subNode = ethers.keccak256(
        ethers.concat([
          parentNode,
          ethers.keccak256(ethers.toUtf8Bytes("sale"))
        ])
      );

      const domain = await registry.getDomain(subNode);
      expect(domain.owner).to.equal(buyer.address);
    });
  });
});
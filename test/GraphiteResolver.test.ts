// test/GraphiteResolver.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { GraphiteDNSRegistry, GraphiteResolver } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GraphiteResolver", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let node: string;

  beforeEach(async () => {
    [owner, user1, user2] = await ethers.getSigners();

    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    resolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await resolver.getAddress());
    
    resolver = await ResolverFactory.deploy(await registry.getAddress());

    await registry.register(
      "test",
      user1.address,
      365 * 24 * 3600,
      await resolver.getAddress(),
      await registry.TLD_NODE()
    );

    node = ethers.keccak256(
      ethers.concat([
        await registry.TLD_NODE(),
        ethers.keccak256(ethers.toUtf8Bytes("test"))
      ])
    );
  });

  describe("Text Records", () => {
    it("Should allow domain owner to set text records", async () => {
      await expect(
        resolver.connect(user1).setText(node, "avatar", "ipfs://QmHash")
      ).to.emit(resolver, "TextChanged");

      expect(await resolver.text(node, "avatar")).to.equal("ipfs://QmHash");
    });

    it("Should prevent non-owner from setting records", async () => {
      await expect(
        resolver.connect(user2).setText(node, "avatar", "ipfs://QmHash")
      ).to.be.revertedWith("Not node owner or expired");
    });

    it("Should allow record deletion", async () => {
      await resolver.connect(user1).setText(node, "url", "https://example.com");
      await resolver.connect(user1).deleteText(node, "url");
      expect(await resolver.text(node, "url")).to.equal("");
    });
  });

  describe("Address Records", () => {
    it("Should set and get address records", async () => {
      await resolver.connect(user1).setAddress(node, user1.address);
      expect(await resolver.addr(node)).to.equal(user1.address);
    });
  });

  describe("Batch Operations", () => {
    it("Should handle multiple text records", async () => {
      const keys = ["avatar", "url"];
      const values = ["ipfs://QmHash", "https://example.com"];
      
      await resolver.connect(user1).setMultipleTexts(node, keys, values);
      
      expect(await resolver.text(node, keys[0])).to.equal(values[0]);
      expect(await resolver.text(node, keys[1])).to.equal(values[1]);
    });
  });
});

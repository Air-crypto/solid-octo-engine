import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";

const requested = process.argv[2];
if (!requested || !isAbsolute(requested)) {
  throw new Error(
    "usage: npm run wallet:create -- /absolute/path/outside-the-repository/execution-wallet.json",
  );
}

const output = resolve(requested);
const repository = resolve(process.cwd());
const fromRepository = relative(repository, output);
if (
  fromRepository === "" ||
  (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))
) {
  throw new Error(
    "refusing to place an execution keypair inside the repository",
  );
}

const keypair = Keypair.generate();
const descriptor = openSync(output, "wx", 0o600);
try {
  writeFileSync(descriptor, JSON.stringify([...keypair.secretKey]), {
    encoding: "utf8",
  });
} finally {
  closeSync(descriptor);
}

process.stdout.write(
  [
    "Dedicated execution wallet created.",
    `Public key: ${keypair.publicKey.toBase58()}`,
    `Keypair file: ${output}`,
    "Fund only with the small SOL amount you are prepared to lose.",
    "This file has no mnemonic recovery phrase. Back it up offline or funds can become unrecoverable.",
    "Never copy it into the repository, a Bot prompt, a cloud computer, chat, or logs.",
    "",
  ].join("\n"),
);

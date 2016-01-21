"use strict";
import BN = require("bn.js");

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockHash: string;
  blockNumber: string; // hex quantity
  transactionHash: string;
  logIndex: string; // hex quantity
  removed?: boolean; // reported by newer clients only
}

export interface DecodedEvent {
  logIndex: number;
  txHash: string;
  token: string;
  kind: string; // "transfer" | "mint" | "burn"
  from: string;
  to: string;
  amount: string; // uint256 as a decimal string
}

function topicToAddress(t: string): string {
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(t) ? "0x" + t.slice(26).toLowerCase() : null;
}

/**
 * Decode an ERC-20 Transfer(address indexed, address indexed, uint256). Returns null for anything
 * else sharing topic0 (e.g. variants with an indexed value: 4 topics, empty data), which would
 * otherwise be silently misread.
 * Mint = from the zero address, burn = to the zero address. A 0x0 -> 0x0 transfer stays "transfer".
 */
export function decodeTransfer(log: RawLog): DecodedEvent {
  if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  const from = topicToAddress(log.topics[1]);
  const to = topicToAddress(log.topics[2]);
  if (!from || !to) return null;
  let kind = "transfer";
  if (from === ZERO_ADDRESS && to !== ZERO_ADDRESS) kind = "mint";
  else if (to === ZERO_ADDRESS && from !== ZERO_ADDRESS) kind = "burn";
  return {
    logIndex: parseInt(log.logIndex, 16),
    txHash: log.transactionHash.toLowerCase(),
    token: log.address.toLowerCase(),
    kind: kind,
    from: from,
    to: to,
    amount: new BN(log.data.slice(2), 16).toString(10)
  };
}

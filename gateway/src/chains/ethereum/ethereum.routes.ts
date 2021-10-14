/* eslint-disable @typescript-eslint/ban-types */
import { Transaction, Wallet } from 'ethers';
import { NextFunction, Router, Request, Response } from 'express';
import { Ethereum } from './ethereum';
import { EthereumConfig } from './ethereum.config';
import { ConfigManager } from '../../services/config-manager';
import { HttpException, asyncHandler } from '../../services/error-handler';
import { latency } from '../../services/base';
import { tokenValueToString } from '../../services/base';
import {
  EthereumTransactionReceipt,
  approve,
  poll,
  getTokenSymbolsToTokens,
} from './ethereum.controllers';
import { UniswapConfig } from './uniswap/uniswap.config';

export interface EthereumNonceRequest {
  privateKey: string; // the user's private Ethereum key
}
export interface EthereumNonceResponse {
  nonce: number; // the user's nonce
}
export interface EthereumAllowancesRequest {
  privateKey: string; // the users private Ethereum key
  spender: string; // the spender address for whom approvals are checked
  tokenSymbols: string[]; // a list of token symbol
}
export interface EthereumAllowancesResponse {
  network: string;
  timestamp: number;
  latency: number;
  spender: string;
  approvals: Record<string, string>;
}
export interface EthereumBalanceRequest {
  privateKey: string; // the users private Ethereum key
  tokenSymbols: string[]; // a list of token symbol
}
export interface EthereumBalanceResponse {
  network: string;
  timestamp: number;
  latency: number;
  balances: Record<string, string>; // the balance should be a string encoded number
}

export interface EthereumApproveRequest {
  amount?: string;
  nonce?: number;
  privateKey: string;
  spender: string;
  token: string;
}

export interface EthereumApproveResponse {
  network: string;
  timestamp: number;
  latency: number;
  tokenAddress: string;
  spender: string;
  amount: string;
  nonce: number;
  approval: Transaction;
}

export interface EthereumPollRequest {
  txHash: string;
}

export interface EthereumPollResponse {
  network: string;
  timestamp: number;
  latency: number;
  txHash: string;
  confirmed: boolean;
  receipt: EthereumTransactionReceipt | null;
}

function getSpender(reqSpender: string): string {
  let spender: string;
  if (reqSpender === 'uniswap') {
    if (ConfigManager.config.ETHEREUM_CHAIN === 'mainnet') {
      spender = UniswapConfig.config.mainnet.uniswapV2RouterAddress;
    } else {
      spender = UniswapConfig.config.kovan.uniswapV2RouterAddress;
    }
  } else {
    spender = reqSpender;
  }

  return spender;
}
export namespace EthereumRoutes {
  export const router = Router();
  export const ethereum = Ethereum.getInstance();

  router.use(
    asyncHandler(async (_req: Request, _res: Response, next: NextFunction) => {
      if (!ethereum.ready()) {
        await ethereum.init();
      }
      return next();
    })
  );

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      let rpcUrl;
      if (ConfigManager.config.ETHEREUM_CHAIN === 'mainnet') {
        rpcUrl = EthereumConfig.config.mainnet.rpcUrl;
      } else {
        rpcUrl = EthereumConfig.config.kovan.rpcUrl;
      }

      res.status(200).json({
        network: ConfigManager.config.ETHEREUM_CHAIN,
        rpcUrl: rpcUrl,
        connection: true,
        timestamp: Date.now(),
      });
    })
  );

  router.post(
    '/nonce',
    asyncHandler(
      async (
        req: Request<{}, {}, EthereumNonceRequest>,
        res: Response<EthereumNonceResponse | string, {}>
      ) => {
        // get the address via the private key since we generally use the private
        // key to interact with gateway and the address is not part of the user config
        const wallet = ethereum.getWallet(req.body.privateKey);
        const nonce = await ethereum.nonceManager.getNonce(wallet.address);
        res.status(200).json({ nonce: nonce });
      }
    )
  );

  router.post(
    '/allowances',
    asyncHandler(
      async (
        req: Request<{}, {}, EthereumAllowancesRequest>,
        res: Response<EthereumAllowancesResponse | string, {}>
      ) => {
        const initTime = Date.now();
        const wallet = ethereum.getWallet(req.body.privateKey);
        const tokens = getTokenSymbolsToTokens(ethereum, req.body.tokenSymbols);
        const spender = getSpender(req.body.spender);

        const approvals: Record<string, string> = {};
        await Promise.all(
          Object.keys(tokens).map(async (symbol) => {
            approvals[symbol] = tokenValueToString(
              await ethereum.getERC20Allowance(
                wallet,
                spender,
                tokens[symbol].address,
                tokens[symbol].decimals
              )
            );
          })
        );

        res.status(200).json({
          network: ConfigManager.config.ETHEREUM_CHAIN,
          timestamp: initTime,
          latency: latency(initTime, Date.now()),
          spender: spender,
          approvals: approvals,
        });
      }
    )
  );

  router.post(
    '/balances',
    asyncHandler(
      async (
        req: Request<{}, {}, EthereumBalanceRequest>,
        res: Response<EthereumBalanceResponse | string, {}>,
        _next: NextFunction
      ) => {
        const initTime = Date.now();

        let wallet: Wallet;
        try {
          wallet = ethereum.getWallet(req.body.privateKey);
        } catch (err) {
          throw new HttpException(500, 'Error getting wallet ' + err);
        }

        const tokens = getTokenSymbolsToTokens(ethereum, req.body.tokenSymbols);

        const balances: Record<string, string> = {};
        balances.ETH = tokenValueToString(await ethereum.getEthBalance(wallet));

        await Promise.all(
          Object.keys(tokens).map(async (symbol) => {
            if (tokens[symbol] !== undefined) {
              const address = tokens[symbol].address;
              const decimals = tokens[symbol].decimals;
              const balance = await ethereum.getERC20Balance(
                wallet,
                address,
                decimals
              );
              balances[symbol] = tokenValueToString(balance);
            }
          })
        );

        res.status(200).json({
          network: ConfigManager.config.ETHEREUM_CHAIN,
          timestamp: initTime,
          latency: latency(initTime, Date.now()),
          balances: balances,
        });
      }
    )
  );

  router.post(
    '/approve',
    asyncHandler(
      async (
        req: Request<{}, {}, EthereumApproveRequest>,
        res: Response<EthereumApproveResponse | string, {}>
      ) => {
        const { nonce, privateKey, token, amount } = req.body;
        const spender = getSpender(req.body.spender);
        const result = await approve(
          ethereum,
          spender,
          privateKey,
          token,
          amount,
          nonce
        );
        return res.status(200).json({
          network: ConfigManager.config.ETHEREUM_CHAIN,
          ...result,
        });
      }
    )
  );

  router.post(
    '/poll',
    asyncHandler(
      async (
        req: Request<{}, {}, EthereumPollRequest>,
        res: Response<EthereumPollResponse, {}>
      ) => {
        const result = await poll(ethereum, req.body.txHash);
        res.status(200).json({
          network: ConfigManager.config.ETHEREUM_CHAIN,
          ...result,
        });
      }
    )
  );
}
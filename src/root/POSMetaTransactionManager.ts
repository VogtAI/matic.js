import fetch from 'node-fetch'

import Web3Client from '../common/Web3Client'
import BN from 'bn.js'

import POSRootChainManager from './root/POSRootChainManager'
import { address, MaticClientInitializationOptions, order, SendOptions } from './types/Common'

const logger = {
  info: require('debug')('maticjs:Web3Client'),
  debug: require('debug')('maticjs:debug:Web3Client'),
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export default class POSMetaTransactionManager {

  private posRootChainManager: POSRootChainManager
  private web3Client: Web3Client
  private relayerAddress: string

  private metaTxEndpoint = "https://ethereumads.com/api/v1.0/metatx"
  private childToken = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
  private childTokenName = "Wrapped Ether"
  private rootChainManagerProxy = "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77"

  constructor(options: MaticClientInitializationOptions, posRootChainManager: POSRootChainManager, web3Client: Web3Client) {
    this.posRootChainManager = posRootChainManager
    this.web3Client = web3Client
    if (options.metaTxEndpoint) {
      this.metaTxEndpoint = options.metaTxEndpoint
    }
  }

  async withdrawETHMetaTx(amount: BN | string, gas: BN | string, options?: SendOptions) {
    this.relayerAddress = (await fetch(this.metaTxEndpoint)).address
    options.encodeAbi = true
    const gasTx = await this.transferWETH(this.relayerAddress, gas)
    const burnRes = await this.posRootChainManager.burnERC20(this.childToken, amount, options)
    const burnTx = await this.metaTx(burnRes.data, burnRes.from, this.childTokenName, burnRes.to) //todo different token names
    const burnTxHash = await this.postData(this.metaTxEndpoint+"/burn", { burnTx, gasTx })

    let exitRes = null
    options.encodeAbi = true
    options.legacyProof = true
    while (!exitRes) {
        logger.info('waiting 5s for checkpoint')
        await sleep(5000)
        try {
            exitRes = await this.posRootChainManager.exitERC20(burnTxHash.result, options)
        } catch (err) {
            logger.debug(err)
        }
    }
    logger.info('txHash', exitRes)
    const exitTx = await this.metaTx(exitRes.data, burnRes.from, "RootChainManager", this.rootChainManagerProxy, false)
    const txHash2 = await this.postData(this.metaTxEndpoint+"/exit", { exitTx, gasTx })

    logger.info('txHash', txHash2)
  }
  
  async metaTx(functionSig: string, addr: string, name: string, verifyingContract: string, matic = true) {
    let salt

    if (matic) {
      salt = "0x0000000000000000000000000000000000000000000000000000000000000089"
    } else {
      salt = "0x0000000000000000000000000000000000000000000000000000000000000001"
    }
    let data = await this.web3Client.getMaticWeb3().eth.abi.encodeFunctionCall({
      name: 'getNonce',
      type: 'function',
      inputs: [{
        name: "user",
        type: "address"
      }]
    }, [addr])
    let _nonce = await this.web3Client.getMaticWeb3().eth.call({
      to: verifyingContract,
      data
    })

    const dataToSign = this.getTypedData({
      name: name,
      version: '1',
      salt: salt, // this is actually the chainid 137
      verifyingContract: verifyingContract,
      nonce: parseInt(_nonce),
      from: addr,
      functionSignature: functionSig
    })
    const msgParams = [addr, JSON.stringify(dataToSign)]

    let sig = await this.web3Client.getMaticWeb3().eth.request({
      method: 'eth_signTypedData_v4',
      params: msgParams
    })

    let txObj = {
      intent: sig,
      fnSig: functionSig,
      dataToSignStr: JSON.stringify(dataToSign), // i added
      from: addr,
      contractAddress: verifyingContract
    }
      return txObj
  }

  async postData(url = '', data = {}) {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow', 
      referrerPolicy: 'no-referrer', 
      body: JSON.stringify(data) 
    })
    return response.json() 
  }
  
   async transferWETH(...args) {
    let functionAbi = {
        "inputs": [
            {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
            },
            {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            }
        ],
        "name": "transfer",
        "outputs": [
            {
                "internalType": "bool",
                "name": "",
                "type": "bool"
            }
        ],
        "stateMutability": "nonpayable",
        "type": "function"
    }
    let data = await this.web3Client.getMaticWeb3().eth.abi.encodeFunctionCall(functionAbi, [...args])
    return this.metaTx(data, this.web3Client.getMaticWeb3().eth.accounts.givenProvider.selectedAddress, this.childTokenName, this.childToken, true)
  }

  getTypedData({ name, version, salt, verifyingContract, nonce, from, functionSignature }) {
    return {
        types: {
        EIP712Domain: [{
            name: 'name',
            type: 'string'
        }, {
            name: 'version',
            type: 'string'
        }, {
            name: 'verifyingContract',
            type: 'address'
        }, {
            name: 'salt',
            type: 'bytes32'
        }],
        MetaTransaction: [{
            name: 'nonce',
            type: 'uint256'
        }, {
            name: 'from',
            type: 'address'
        }, {
            name: 'functionSignature',
            type: 'bytes'
        }]
        },
        domain: {
        name,
        version,
        verifyingContract,
        salt
        },
        primaryType: 'MetaTransaction',
        message: {
        nonce,
        from,
        functionSignature
        }
    }
  }
}

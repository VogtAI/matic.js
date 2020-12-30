let fetch;
try {
  fetch = require('node-fetch'); // eslint-disable-line global-require
} catch (Exception) {
  fetch = window.fetch.bind(window);
}

import Web3Client from '../common/Web3Client'
import BN from 'bn.js'

import POSRootChainManager from './POSRootChainManager'
import { address, MaticClientInitializationOptions, order, SendOptions } from '../types/Common'
import { AbiItem } from "web3-utils";

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
  private relayerAddress: address
  private ethInstance: any

  private metaTxEndpoint = "https://ethereumads.com/api/v1.0/metatx"
  private childToken: address = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
  private childTokenName = "Wrapped Ether"
  private rootChainManagerProxy: address = "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77"

  constructor(options: MaticClientInitializationOptions, posRootChainManager: POSRootChainManager, web3Client: Web3Client, ethInstance: any) {
    this.posRootChainManager = posRootChainManager
    this.web3Client = web3Client
    this.ethInstance = ethInstance
    //if (options.metaTxEndpoint) {
    //  this.metaTxEndpoint = options.metaTxEndpoint
    //}
  }

  async withdrawETHMetaTx(amount: BN | string, gas: BN | string, options?: SendOptions) {
    const metaTxEndpointInfo = (await (await fetch(this.metaTxEndpoint)).json())
    console.log('matictest 0', fetch, this.metaTxEndpoint, metaTxEndpointInfo, metaTxEndpointInfo.address)

    this.relayerAddress = <address> metaTxEndpointInfo.address
    options.encodeAbi = true
    console.log('matictest 1', this.relayerAddress)
    const gasTx = await this.transferWETH(options.from, this.relayerAddress, gas) //todo options.from not needed
    console.log('matictest 2', this.childToken, options)

    const burnRes = await this.posRootChainManager.burnERC20(this.childToken, amount, options)
    console.log('matictest 3', burnRes)

    const burnTx = await this.metaTx(burnRes.data, burnRes.from, this.childTokenName, burnRes.to) //todo different token names
    console.log('matictest 4', burnTx)

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

    let web3provider; 
    if (matic) {
      salt = "0x0000000000000000000000000000000000000000000000000000000000000089"
      web3provider = this.web3Client.getMaticWeb3()
    } else {
      salt = "0x0000000000000000000000000000000000000000000000000000000000000001"
      web3provider = this.web3Client.parentWeb3
    }
    let data = await web3provider.eth.abi.encodeFunctionCall({
      name: 'getNonce',
      type: 'function',
      inputs: [{
        name: "user",
        type: "address"
      }]
    }, [addr])
    let _nonce = await web3provider.eth.call({
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

    let sig = await this.ethInstance.request({
      method: 'eth_signTypedData_v4',
      params: msgParams,
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
  
   async transferWETH(from, ...args) {
    let functionAbi = <AbiItem> {
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
    return this.metaTx(data, from, this.childTokenName, this.childToken, true)
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

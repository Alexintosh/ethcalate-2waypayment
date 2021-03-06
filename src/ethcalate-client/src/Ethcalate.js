const axios = require('axios')
const check = require('check-types')
const getWeb3 = require('../web3')
const contract = require('truffle-contract')
const abi = require('ethereumjs-abi')
const artifacts = require('../../../build/contracts/ChannelManager.json')

module.exports = class Ethcalate {
  constructor (contractAddress, apiUrl) {
    this.contractAddress = contractAddress
    if (apiUrl) {
      this.apiUrl = apiUrl
    } else {
      this.apiUrl = 'http://localhost:3000'
    }
  }

  async initContract () {
    // init web3
    const result = await getWeb3
    this.web3 = result.web3
    this.account = this.web3.eth.accounts[0]

    // init channel manager
    const ChannelManager = contract(artifacts)
    ChannelManager.setProvider(this.web3.currentProvider)
    ChannelManager.defaults({ from: this.web3.eth.accounts[0] })

    // init instance
    let channelManager
    if (this.contractAddress) {
      channelManager = await ChannelManager.at(this.contractAddress)
    } else {
      channelManager = await ChannelManager.deployed()
    }
    this.channelManager = channelManager
  }

  async openChannel ({ to, depositInEth, challenge }) {
    if (!this.channelManager) {
      throw new Error('Please call initContract()')
    }
    check.assert.string(to, 'No counterparty address provided')
    check.assert.string(depositInEth, 'No initial deposit provided')
    check.assert.string(challenge, 'No challenge timer provided')

    const result = await this.channelManager.openChannel(to, challenge, {
      from: this.account,
      value: this.web3.toWei(depositInEth, 'ether')
    })
    return result
  }

  async joinChannel ({ channelId, depositInEth }) {
    if (!this.channelManager) {
      throw new Error('Please call initContract()')
    }
    check.assert.string(channelId, 'No channelId provided')
    check.assert.string(depositInEth, 'No initial deposit provided')

    const result = await this.channelManager.joinChannel(channelId, {
      from: this.web3.eth.accounts[0],
      value: this.web3.toWei(depositInEth, 'ether')
    })
    return result
  }

  async signTx ({ channelId, nonce, balanceA, balanceB }) {
    // fingerprint = keccak256(channelId, nonce, balanceA, balanceB)
    let hash = abi
      .soliditySHA3(
        ['bytes32', 'uint256', 'uint256', 'uint256'],
        [channelId, nonce, balanceA, balanceB]
      )
      .toString('hex')
    hash = `0x${hash}`
    console.log('hash: ', hash)
    console.log('signer: ', this.web3.eth.accounts[0])
    const sig = new Promise((resolve, reject) => {
      this.web3.eth.sign(this.web3.eth.accounts[0], hash, (error, result) => {
        if (error) {
          reject(error)
        } else {
          resolve(result)
        }
      })
    })
    return sig
  }

  async updateState ({
    channelId,
    nonce,
    balanceA,
    balanceB,
    isAgentA // bool, if false, is AgentB
  }) {
    if (!this.channelManager) {
      throw new Error('Please call initContract()')
    }

    const sig = await this.signTx({ channelId, nonce, balanceA, balanceB })

    // set variables based on who signed it
    const sigA = isAgentA ? sig : ''
    const sigB = !isAgentA ? sig : ''
    const requireSigA = isAgentA
    const requireSigB = !isAgentA

    const response = await axios.post(`${this.apiUrl}/state`, {
      channelId,
      nonce,
      balanceA,
      balanceB,
      sigA,
      sigB,
      requireSigA,
      requireSigB
    })
    return response.data
  }

  async startChallengePeriod (channelId) {
    if (!this.channelManager) {
      throw new Error('Please call initContract()')
    }
    let response = await axios.get(`${this.apiUrl}/channel/${channelId}`)
    let { channel } = response.data
    let sig
    if (channel.agentA === this.web3.eth.accounts[0]) {
      // need sigB
      sig = 'sigB'
    } else if (channel.agentB === this.web3.eth.accounts[0]) {
      // need sigA
      sig = 'sigA'
    } else {
      throw new Error('Not my channel')
    }

    response = await axios.get(
      `${this.apiUrl}/channel/${channelId}/latest?sig=${sig}`
    )
    channel = response.data.channel

    const latestCountersignedTransction = channel.transactions[0]
    if (latestCountersignedTransction) {
      const {
        nonce,
        balanceA,
        balanceB,
        sigA,
        sigB
      } = latestCountersignedTransction
      const signedTx = await this.signTx({
        channelId,
        nonce,
        balanceA,
        balanceB
      })
      if (sig === 'sigA') {
        // ours is sigB
        await this.channelManager.startChallenge(
          channelId,
          nonce,
          balanceA,
          balanceB,
          sigA,
          signedTx
        )
      } else {
        // ours is sigA
        await this.channelManager.startChallenge(
          channelId,
          nonce,
          balanceA,
          balanceB,
          signedTx,
          sigB
        )
      }
    } else {
      // no countersigned transactions
    }
  }

  async closeChannel (channelId) {
    const res = await this.channelManager.closeChannel(channelId)
    console.log('res: ', res)
  }

  async updatePhone (phone) {
    check.assert.string(phone, 'No phone number provided')
    const response = await axios.post(`${this.apiUrl}/updatePhone`, {
      address: this.account,
      phone: phone
    })
    return response.data
  }

  async getChannel (channelId) {
    check.assert.string(channelId, 'No channelId provided')
    const response = await axios.get(`${this.apiUrl}/channel/${channelId}`)
    return response.data
  }

  async getMyChannels () {
    const response = await axios.get(
      `${this.apiUrl}/channel?address=${this.account}`
    )
    if (response.data) {
      return response.data.channels.map(channel => {
        channel.depositA = this.web3.fromWei(channel.depositA, 'ether')
        channel.depositB = this.web3.fromWei(channel.depositB, 'ether')

        // if balances dont exist from stateUpdate, balance = deposit
        channel.balanceA = channel.balanceA
          ? channel.balanceA
          : channel.depositA
        channel.balanceB = channel.balanceB
          ? channel.balanceB
          : channel.depositB
        return channel
      })
    } else {
      return []
    }
  }

  async getChannelByAddresses (agentA, agentB) {
    check.assert.string(agentA, 'No agentA account provided')
    check.assert.string(agentB, 'No agentB account provided')
    const response = await axios.get(
      `${this.apiUrl}/channel/${agentA}/${agentB}`
    )
    return response.data
  }
}

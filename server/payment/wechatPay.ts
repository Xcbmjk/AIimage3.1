import crypto from 'node:crypto'
import fs from 'node:fs'
import type { ServerConfig } from '../config'

type WechatPaymentConfig = ServerConfig['payment']

const apiHost = 'https://api.mch.weixin.qq.com'

function signatureMessage(timestamp: string, nonce: string, body: string) {
  return `${timestamp}\n${nonce}\n${body}\n`
}

export class WechatPayClient {
  private readonly privateKey: string
  private readonly publicKey: string

  constructor(private readonly config: WechatPaymentConfig) {
    this.privateKey = fs.readFileSync(config.privateKeyPath, 'utf8')
    this.publicKey = fs.readFileSync(config.wechatPayPublicKeyPath, 'utf8')
  }

  private authorization(method: string, pathname: string, body: string) {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = crypto.randomBytes(16).toString('hex')
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${method}\n${pathname}\n${timestamp}\n${nonce}\n${body}\n`), this.privateKey).toString('base64')
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.certificateSerial}",signature="${signature}"`
  }

  async createNativeOrder(order: { id: string; sessionId: string; amountFen: number; expiresAt: string }) {
    const pathname = '/v3/pay/transactions/native'
    const body = JSON.stringify({
      appid: this.config.appId,
      mchid: this.config.mchId,
      description: this.config.description,
      out_trade_no: order.id,
      time_expire: order.expiresAt,
      attach: order.sessionId,
      notify_url: `${this.config.publicBaseUrl}/api/payments/wechat/notify`,
      amount: { total: order.amountFen, currency: 'CNY' },
    })
    const response = await fetch(`${apiHost}${pathname}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Wechatpay-Serial': this.config.wechatPayPublicKeyId,
        Authorization: this.authorization('POST', pathname, body),
      },
      body,
    })
    const responseBody = await response.text()
    this.verifyResponse(response.headers, responseBody)
    if (!response.ok) throw new Error(`微信支付下单失败 (${response.status})`)
    const result = JSON.parse(responseBody) as { code_url?: string }
    if (!result.code_url) throw new Error('微信支付未返回付款二维码')
    return result.code_url
  }

  verifyResponse(headers: Headers, body: string) {
    const timestamp = headers.get('wechatpay-timestamp')
    const nonce = headers.get('wechatpay-nonce')
    const signature = headers.get('wechatpay-signature')
    const serial = headers.get('wechatpay-serial')
    if (!timestamp || !nonce || !signature || serial !== this.config.wechatPayPublicKeyId) throw new Error('微信支付响应缺少有效签名')
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error('微信支付响应签名已过期')
    if (!crypto.verify('RSA-SHA256', Buffer.from(signatureMessage(timestamp, nonce, body)), this.publicKey, Buffer.from(signature, 'base64'))) {
      throw new Error('微信支付响应验签失败')
    }
  }

  verifyNotification(headers: Record<string, string | string[] | undefined>, rawBody: string) {
    const timestamp = String(headers['wechatpay-timestamp'] ?? '')
    const nonce = String(headers['wechatpay-nonce'] ?? '')
    const signature = String(headers['wechatpay-signature'] ?? '')
    const serial = String(headers['wechatpay-serial'] ?? '')
    if (!timestamp || !nonce || !signature || serial !== this.config.wechatPayPublicKeyId) return false
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
    return crypto.verify('RSA-SHA256', Buffer.from(signatureMessage(timestamp, nonce, rawBody)), this.publicKey, Buffer.from(signature, 'base64'))
  }

  decryptNotification(resource: { ciphertext: string; nonce: string; associated_data?: string }) {
    const encrypted = Buffer.from(resource.ciphertext, 'base64')
    const authTag = encrypted.subarray(encrypted.length - 16)
    const ciphertext = encrypted.subarray(0, encrypted.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this.config.apiV3Key), Buffer.from(resource.nonce))
    decipher.setAuthTag(authTag)
    if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data))
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as {
      out_trade_no: string
      transaction_id: string
      trade_state: string
      mchid: string
      amount: { total: number; currency: string }
    }
  }
}

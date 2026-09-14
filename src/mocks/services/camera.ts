import type { CameraService } from '../../services/contracts'
import { demoPhoto } from '../fixtures/styles'

export const mockCameraService: CameraService = {
  async start(video) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前设备未检测到摄像头')
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1440 } },
      audio: false,
    })
    video.srcObject = stream
    await video.play()
    return stream
  },
  capture(video) {
    if (!video.videoWidth) return { url: demoPhoto, source: 'demo' }
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    return { url: canvas.toDataURL('image/jpeg', 0.9), source: 'camera' }
  },
  stop(stream) {
    stream?.getTracks().forEach((track) => track.stop())
  },
}

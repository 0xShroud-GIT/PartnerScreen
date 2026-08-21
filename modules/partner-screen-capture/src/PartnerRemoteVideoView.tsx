import { requireNativeViewManager } from 'expo-modules-core';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export interface PartnerRemoteVideoFirstFrame { sessionId: string }
export interface PartnerRemoteVideoFrameResolution { sessionId: string; width: number; height: number; rotation: number }
export interface PartnerRemoteVideoViewProps extends ViewProps {
  sessionId: string;
  onFirstFrame?: (event: NativeSyntheticEvent<PartnerRemoteVideoFirstFrame>) => void;
  onFrameResolution?: (event: NativeSyntheticEvent<PartnerRemoteVideoFrameResolution>) => void;
}

export default requireNativeViewManager<PartnerRemoteVideoViewProps>('PartnerScreenCapture');

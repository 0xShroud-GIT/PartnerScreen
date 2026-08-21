import { requireNativeViewManager } from 'expo-modules-core';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export interface PartnerRemoteVideoFirstFrame { sessionId: string }
export interface PartnerRemoteVideoViewProps extends ViewProps {
  sessionId: string;
  onFirstFrame?: (event: NativeSyntheticEvent<PartnerRemoteVideoFirstFrame>) => void;
}

export default requireNativeViewManager<PartnerRemoteVideoViewProps>('PartnerScreenCapture');

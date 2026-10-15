'use client';

import { Center } from '@lobehub/ui';
import { createModal, type ModalInstance, Spin, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { SandboxStorageUpgradeGuide } from '@/business/client/features/SandboxStorageUpsell';
import { useSandboxDriveEntitlement } from '@/hooks/useSandboxDriveEntitlement';

import { DirectoryBrowser } from './DirectoryBrowser';
import { useSandboxDirectorySource } from './sources/useSandboxDirectorySource';

/** What a pick on the drive binds the conversation to. */
export type SandboxDirectoryPick = { instanceId: string } | { workingDirectory: string };

interface SandboxDirectoryContentProps {
  agentIsPublic?: boolean;
  defaultPath?: string;
  isSharedDrive: boolean;
  onPick: (pick: SandboxDirectoryPick) => void | Promise<void>;
  topicId?: string;
}

const SandboxDirectoryContent = ({
  agentIsPublic,
  defaultPath,
  isSharedDrive,
  onPick,
  topicId,
}: SandboxDirectoryContentProps) => {
  const { t: tDevice } = useTranslation('device');
  const { close } = useModalContext();
  const { entitled } = useSandboxDriveEntitlement();

  const onPickInstance = useCallback(
    (instanceId: string) => {
      close();
      void onPick({ instanceId });
    },
    [close, onPick],
  );

  const source = useSandboxDirectorySource({
    agentIsPublic,
    isSharedDrive,
    onPickInstance,
    topicId,
  });

  // Without a drive there is nothing to browse: the way to one stands where
  // the folders would be.
  if (entitled === false) return <SandboxStorageUpgradeGuide />;
  if (entitled === undefined) {
    return (
      <Center style={{ minHeight: 240 }}>
        <Spin />
      </Center>
    );
  }

  return (
    <DirectoryBrowser
      defaultPath={defaultPath}
      loading={false}
      source={source}
      description={tDevice(
        isSharedDrive
          ? 'workingDirectory.drive.browseDescriptionShared'
          : 'workingDirectory.drive.browseDescription',
      )}
      onCancel={close}
      onSelect={(path) => {
        close();
        // The root is a choice of its own — `.` — distinct from "no folder",
        // which is the temporary sandbox.
        void onPick({ workingDirectory: path || '.' });
      }}
    />
  );
};

/**
 * Pick where a cloud-sandbox conversation works on the drive: a folder, the
 * root (personal drives only), or an environment directory — or initialize a
 * new folder from a code environment.
 */
export const openSandboxDirectoryModal = (props: SandboxDirectoryContentProps): ModalInstance =>
  createModal({
    content: <SandboxDirectoryContent {...props} />,
    footer: null,
    maskClosable: true,
    styles: { header: { borderBottom: 'none' } },
    title: t('workingDirectory.drive.title', { ns: 'device' }),
    width: 'min(90vw, 600px)',
  });

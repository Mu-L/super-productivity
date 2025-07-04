import { getSyncStatusFromMetaFiles } from './get-sync-status-from-meta-files';
import { ConflictReason, SyncStatus } from '../pfapi.const';
import { LocalMeta, RemoteMeta, VectorClock } from '../pfapi.model';
import { VectorClockComparison } from './vector-clock';

describe('getSyncStatusFromMetaFiles with Vector Clocks', () => {
  // Helper to create test data with vector clocks
  const createMetaWithVectorClock = (
    localLastUpdate: number,
    remoteLastUpdate: number,
    lastSyncedUpdate: number | null = null,
    vectorClockData?: {
      localVector?: VectorClock;
      remoteVector?: VectorClock;
      lastSyncedVector?: VectorClock | null;
    },
  ): { local: LocalMeta; remote: RemoteMeta } => {
    const local: LocalMeta = {
      lastUpdate: localLastUpdate,
      lastSyncedUpdate: lastSyncedUpdate,
      crossModelVersion: 1,
      metaRev: 'test-rev',
      revMap: {},
      localLamport: 0,
      lastSyncedLamport: null,
      vectorClock: vectorClockData?.localVector,
      lastSyncedVectorClock: vectorClockData?.lastSyncedVector,
    };

    const remote: RemoteMeta = {
      lastUpdate: remoteLastUpdate,
      crossModelVersion: 1,
      revMap: {},
      mainModelData: {},
      localLamport: 0,
      lastSyncedLamport: null,
      vectorClock: vectorClockData?.remoteVector,
    };

    return { local, remote };
  };

  describe('Vector Clock Sync Status Detection', () => {
    it('should detect InSync when vector clocks are equal', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, 1000, {
        localVector: { clientA: 5, clientB: 3 },
        remoteVector: { clientA: 5, clientB: 3 },
        lastSyncedVector: { clientA: 5, clientB: 3 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.InSync);
    });

    it('should detect UpdateLocal when remote is ahead', () => {
      const { local, remote } = createMetaWithVectorClock(1500, 2000, 1000, {
        localVector: { clientA: 3, clientB: 2 },
        remoteVector: { clientA: 5, clientB: 3 },
        lastSyncedVector: { clientA: 3, clientB: 2 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateLocal);
    });

    it('should detect UpdateRemote when local is ahead', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, 1000, {
        localVector: { clientA: 5, clientB: 3 },
        remoteVector: { clientA: 3, clientB: 2 },
        lastSyncedVector: { clientA: 3, clientB: 2 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });

    it('should detect Conflict when vector clocks are concurrent', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 2000, 1000, {
        localVector: { clientA: 5, clientB: 2 },
        remoteVector: { clientA: 3, clientB: 4 },
        lastSyncedVector: { clientA: 3, clientB: 2 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.Conflict);
      expect(result.conflictData).toBeDefined();
      expect(result.conflictData?.reason).toBe(ConflictReason.BothNewerLastSync);
      expect(result.conflictData?.additional).toEqual({
        vectorClockComparison: VectorClockComparison.CONCURRENT,
        localVector: '{clientA:5, clientB:2}',
        remoteVector: '{clientA:3, clientB:4}',
      });
    });

    it('should handle missing components in vector clocks', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, 1000, {
        localVector: { clientA: 5, clientB: 3, clientC: 1 },
        remoteVector: { clientA: 5, clientB: 3 },
        lastSyncedVector: { clientA: 5, clientB: 3 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });

    it('should handle empty lastSyncedVector', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, null, {
        localVector: { clientA: 5 },
        remoteVector: { clientA: 3 },
        lastSyncedVector: null,
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });

    it('should fall back to Lamport when vector clocks are not available', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, 1000);
      // Add Lamport data
      local.localLamport = 5;
      local.lastSyncedLamport = 3;
      remote.localLamport = 3;

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });

    it('should prefer vector clocks over Lamport when both are available', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 2000, 1000, {
        localVector: { clientA: 5, clientB: 3 },
        remoteVector: { clientA: 5, clientB: 3 },
        lastSyncedVector: { clientA: 5, clientB: 3 },
      });
      // Add conflicting Lamport data that would indicate UpdateRemote
      local.localLamport = 10;
      local.lastSyncedLamport = 5;
      remote.localLamport = 5;

      const result = getSyncStatusFromMetaFiles(remote, local);
      // Should use vector clock result (InSync) not Lamport result
      expect(result.status).toBe(SyncStatus.InSync);
    });

    it('should handle when only one side has vector clocks', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, 1000, {
        localVector: { clientA: 5 },
        // remote has no vector clock
      });
      // Add Lamport data as fallback
      local.localLamport = 5;
      local.lastSyncedLamport = 3;
      remote.localLamport = 3;

      const result = getSyncStatusFromMetaFiles(remote, local);
      // Should fall back to Lamport
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });

    it('should handle mixed vector clock states without conflict when no changes', () => {
      const { local, remote } = createMetaWithVectorClock(1500, 1500, 1500, {
        localVector: { clientA: 3 },
        // remote has no vector clock
      });
      // Add matching Lamport data
      local.localLamport = 3;
      local.lastSyncedLamport = 3;
      remote.localLamport = 3;

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.InSync);
    });

    it('should handle mixed states with remote having vector clock', () => {
      const { local, remote } = createMetaWithVectorClock(1500, 2000, 1000, {
        remoteVector: { clientB: 5 },
        // local has no vector clock
      });
      // Add Lamport data
      local.localLamport = 3;
      local.lastSyncedLamport = 3;
      remote.localLamport = 5;

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateLocal);
    });

    it('should use timestamps when mixed states lack change counters', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, null, {
        localVector: { clientA: 5 },
        // remote has no vector clock
      });
      // No valid Lamport data

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });

    it('should detect diverged changes with partial vector clock overlap', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 2000, 1000, {
        localVector: { clientA: 5, clientB: 2, clientC: 7 },
        remoteVector: { clientA: 3, clientB: 4, clientD: 2 },
        lastSyncedVector: { clientA: 3, clientB: 2 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.Conflict);
    });

    it('should handle vector clock with resolved conflict scenario', () => {
      // Scenario: A and B had concurrent changes, then A merged B's changes
      const { local, remote } = createMetaWithVectorClock(3000, 2000, 2000, {
        localVector: { clientA: 6, clientB: 4 }, // A incremented after merge
        remoteVector: { clientA: 5, clientB: 4 }, // B's state before A's merge
        lastSyncedVector: { clientA: 5, clientB: 4 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });
  });

  describe('Edge Cases', () => {
    it('should handle when timestamps match but vector clocks differ', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 2000, 1500, {
        localVector: { clientA: 5 },
        remoteVector: { clientA: 5 },
        lastSyncedVector: { clientA: 4 },
      });

      const result = getSyncStatusFromMetaFiles(remote, local);
      // Timestamps match exactly, so should be InSync
      expect(result.status).toBe(SyncStatus.InSync);
    });

    it('should handle empty vector clocks', () => {
      const { local, remote } = createMetaWithVectorClock(2000, 1500, 1000, {
        localVector: {},
        remoteVector: {},
        lastSyncedVector: {},
      });
      // Add Lamport as fallback
      local.localLamport = 5;
      local.lastSyncedLamport = 3;
      remote.localLamport = 3;

      const result = getSyncStatusFromMetaFiles(remote, local);
      // Empty vector clocks should fall back to Lamport
      expect(result.status).toBe(SyncStatus.UpdateRemote);
    });
  });
});

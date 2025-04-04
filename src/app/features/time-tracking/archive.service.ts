import { inject, Injectable } from '@angular/core';
import { TaskWithSubTasks } from '../tasks/task.model';
import { flattenTasks } from '../tasks/store/task.selectors';
import { createEmptyEntity } from '../../util/create-empty-entity';
import { taskAdapter } from '../tasks/store/task.adapter';
import { PfapiService } from '../../pfapi/pfapi.service';
import {
  sortTimeTrackingAndTasksFromArchiveYoungToOld,
  sortTimeTrackingDataToArchiveYoung,
} from './sort-data-to-flush';
import { Store } from '@ngrx/store';
import { TimeTrackingActions } from './store/time-tracking.actions';

/*
# Considerations for flush architecture:
** The main purpose of flushing is mainly to reduce the amount of data that needs to be transferred over the network **
Roughly we aim at these 3 syncs to occur under normal circumstances:

every sync  => sync the meta file
daily       => +archiveYoung (moving tasks to archive)
less often  => +archiveOld (after flushing data from archiveYoung to archiveOld)

## Other considerations:

timeTracking:
* (currently) there seems to be no writing of archiveYoung or archiveOld like there is for archive tasks, when editing tasks in worklog
=> archiveOld.timeTracking and archiveYoung.timeTracking can be read-only
* data for today should never be in the archive and always be in the store to avoid problems when doing partial updates
=> timeTracking should always retain some data, at least for today, probably better for the current week

taskArchive:
* data in archiveYoung should be faster to access and write
* when updating some old data, we need to upload archiveOld regardless of flushing
=> makes sense to retain data in archiveYoung that is likely to be accessed more often
=> 31 days is maybe a good middle ground for this, since it allows us to access and write data from the last month
 */

export const ARCHIVE_CURRENT_TO_YOUNG_THRESHOLD = 1000 * 60 * 60 * 24 * 14; // two weeks
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const ARCHIVE_YOUNG_TO_OLD_THRESHOLD = 1000 * 60 * 60 * 24 * 31; // 31 days

@Injectable({
  providedIn: 'root',
})
export class ArchiveService {
  private readonly _pfapiService = inject(PfapiService);
  private readonly _store = inject(Store);

  // NOTE: we choose this method as trigger to check for flushing to archive, since
  // it is usually triggered every work-day once
  async moveTasksToArchiveAndFlushArchiveIfDue(tasks: TaskWithSubTasks[]): Promise<void> {
    const now = Date.now();
    const flatTasks = flattenTasks(tasks);
    if (!flatTasks.length) {
      return;
    }

    const archiveYoung = await this._pfapiService.m.archiveYoung.load();
    const taskArchiveState = archiveYoung.task || createEmptyEntity();

    const newTaskArchive = taskAdapter.addMany(
      flatTasks.map(({ subTasks, ...task }) => ({
        ...task,
        reminderId: undefined,
        isDone: true,
        plannedAt: undefined,
        doneOn:
          task.isDone && task.doneOn
            ? task.doneOn
            : task.parentId
              ? flatTasks.find((t) => t.id === task.parentId)?.doneOn || now
              : now,
      })),
      taskArchiveState,
    );

    const isFlushTimeTracking =
      now - archiveYoung.lastTimeTrackingFlush > ARCHIVE_CURRENT_TO_YOUNG_THRESHOLD;

    // Result A: Just move tasks to archive
    if (!isFlushTimeTracking) {
      await this._pfapiService.m.archiveYoung.save(
        {
          timeTracking: archiveYoung.timeTracking,
          lastTimeTrackingFlush: archiveYoung.lastTimeTrackingFlush,
          task: newTaskArchive,
        },
        {
          isUpdateRevAndLastUpdate: true,
        },
      );
      return;
    }

    // ------------------------------------------------
    // Result B:
    // Also move timeTracking data to archiveYoung
    const newSorted1 = sortTimeTrackingDataToArchiveYoung({
      // TODO think if it is better to get this from store as it is fresher potentially
      timeTracking: await this._pfapiService.m.timeTracking.load(),
      archiveYoung,
    });
    const newArchiveYoung = {
      ...newSorted1.archiveYoung,
      task: newTaskArchive,
      lastFlush: now,
    };
    await this._pfapiService.m.archiveYoung.save(newArchiveYoung, {
      isUpdateRevAndLastUpdate: true,
    });
    this._store.dispatch(
      TimeTrackingActions.updateWholeState({
        newState: newSorted1.timeTracking,
      }),
    );

    // ------------------------------------------------
    const archiveOld = await this._pfapiService.m.archiveOld.load();
    const isFlushArchiveOld =
      now - archiveOld.lastTimeTrackingFlush > ARCHIVE_YOUNG_TO_OLD_THRESHOLD;
    if (!isFlushArchiveOld) {
      return;
    }

    // ------------------------------------------------
    // Result C:
    // Also sort timeTracking and task data from archiveYoung to archiveOld
    const newSorted2 = sortTimeTrackingAndTasksFromArchiveYoungToOld({
      archiveYoung: newArchiveYoung,
      archiveOld,
      threshold: ARCHIVE_YOUNG_TO_OLD_THRESHOLD,
      now,
    });
    await this._pfapiService.m.archiveYoung.save(
      {
        ...newSorted2.archiveYoung,
        lastTimeTrackingFlush: now,
      },
      {
        isUpdateRevAndLastUpdate: true,
      },
    );
    await this._pfapiService.m.archiveOld.save(
      {
        ...newSorted2.archiveOld,
        lastTimeTrackingFlush: now,
      },
      {
        isUpdateRevAndLastUpdate: true,
      },
    );
  }
}

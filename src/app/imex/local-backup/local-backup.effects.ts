import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { take, tap } from 'rxjs/operators';
import { loadAllData } from '../../root-store/meta/load-all-data.action';
import { AppDataCompleteLegacy } from '../sync/sync.model';
import { IS_ELECTRON } from '../../app.constants';
import { LocalBackupService } from './local-backup.service';
import { TranslateService } from '@ngx-translate/core';
import { T } from '../../t.const';
import moment from 'moment';
import { IS_ANDROID_BACKUP_READY } from '../../features/android/android-interface';
import { IS_ANDROID_WEB_VIEW } from '../../util/is-android-web-view';
import { AppDataCompleteNew } from '../../pfapi/pfapi-config';
import { PfapiService } from '../../pfapi/pfapi.service';

@Injectable()
export class LocalBackupEffects {
  private _actions$ = inject(Actions);
  private _localBackupService = inject(LocalBackupService);
  private _translateService = inject(TranslateService);
  private _pfapiService = inject(PfapiService);

  checkForBackupIfNoTasks$: any =
    (IS_ELECTRON || IS_ANDROID_BACKUP_READY) &&
    createEffect(
      () =>
        this._actions$.pipe(
          ofType(loadAllData),
          take(1),
          tap(({ appDataComplete }) => {
            this._checkForBackupIfEmpty(appDataComplete);
          }),
        ),
      { dispatch: false },
    );

  private async _checkForBackupIfEmpty(
    appDataComplete: AppDataCompleteLegacy | AppDataCompleteNew,
  ): Promise<void> {
    if (
      appDataComplete.task.ids.length === 0 &&
      appDataComplete.taskArchive.ids.length === 0 &&
      !(appDataComplete as AppDataCompleteLegacy).lastLocalSyncModelChange
    ) {
      const backupMeta = await this._localBackupService.checkBackupAvailable();

      // ELECTRON
      // --------
      if (IS_ELECTRON && typeof backupMeta !== 'boolean') {
        if (
          confirm(
            this._translateService.instant(T.CONFIRM.RESTORE_FILE_BACKUP, {
              dir: backupMeta.folder,
              from: this._formatDate(backupMeta.created),
            }),
          )
        ) {
          const backupData = await this._localBackupService.loadBackupElectron(
            backupMeta.path,
          );
          console.log('backupData', backupData);
          await this._pfapiService.importCompleteBackup(JSON.parse(backupData));
        }

        // ANDROID
        // -------
      } else if (IS_ANDROID_WEB_VIEW && backupMeta === true) {
        if (
          confirm(this._translateService.instant(T.CONFIRM.RESTORE_FILE_BACKUP_ANDROID))
        ) {
          const backupData = await this._localBackupService.loadBackupAndroid();
          console.log('backupData', backupData);
          const lineBreaksReplaced = backupData.replace(/\n/g, '\\n');
          console.log('lineBreaksReplaced', lineBreaksReplaced);
          await this._pfapiService.importCompleteBackup(JSON.parse(lineBreaksReplaced));
        }
      }
    }
  }

  private _formatDate(date: Date | string | number): string {
    return moment(date).format('DD-MM-YYYY, hh:mm:ss');
  }
}

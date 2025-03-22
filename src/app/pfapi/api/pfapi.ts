import {
  AllSyncModels,
  ConflictData,
  ExtractModelCfgType,
  ModelBase,
  ModelCfgs,
  ModelCfgToModelCtrl,
  PfapiBaseCfg,
} from './pfapi.model';
import { SyncService } from './sync/sync.service';
import { Database } from './db/database';
import { IndexedDbAdapter } from './db/indexed-db-adapter';
import { MetaModelCtrl } from './model-ctrl/meta-model-ctrl';
import { ModelCtrl } from './model-ctrl/model-ctrl';
import { MiniObservable } from './util/mini-observable';
import { SyncProviderServiceInterface } from './sync/sync-provider.interface';
import { pfLog } from './util/log';
import { SyncProviderId, SyncStatus } from './pfapi.const';
import { EncryptAndCompressHandlerService } from './sync/encrypt-and-compress-handler.service';
import { SyncProviderCredentialsStore } from './sync/sync-provider-credentials-store';
import {
  DataValidationFailedError,
  InvalidModelCfgError,
  InvalidSyncProviderError,
  ModelIdWithoutCtrlError,
  NoRepairFunctionProvidedError,
  NoSyncProviderSetError,
  NoValidateFunctionProvidedError,
} from './errors/errors';

// type EventMap = {
// 'sync:start': undefined;
// 'sync:complete': { success: boolean; timestamp: number };
// 'sync:error': Error;
// 'model:changed': { modelId: string; timestamp: number };
// 'credentials:update': { credentials: unknown };
// };

// export class <PCfg extends Cfg, Ms extends ModelCfg<any>[]> {
export class Pfapi<const MD extends ModelCfgs> {
  private static _wasInstanceCreated = false;

  private readonly _syncService: SyncService<MD>;
  private readonly _activeSyncProvider$: MiniObservable<SyncProviderServiceInterface<unknown> | null> =
    new MiniObservable<SyncProviderServiceInterface<unknown> | null>(null);
  private readonly _cfg?: PfapiBaseCfg<MD>;

  // private readonly _eventHandlers = new Map<
  //   keyof EventMap,
  //   Record<symbol, (data: unknown) => void>
  // >();

  public readonly db: Database;
  public readonly metaModel: MetaModelCtrl;
  public readonly m: ModelCfgToModelCtrl<MD>;
  public readonly syncProviders: SyncProviderServiceInterface<unknown>[];

  public readonly isSyncProviderActiveAndReady$: MiniObservable<boolean> =
    new MiniObservable<boolean>(false);

  constructor(
    modelCfgs: MD,
    syncProviders: SyncProviderServiceInterface<unknown>[],
    cfg?: PfapiBaseCfg<MD>,
  ) {
    if (Pfapi._wasInstanceCreated) {
      throw new Error(': This should only ever be instantiated once');
    }
    Pfapi._wasInstanceCreated = true;

    this._cfg = cfg;
    const IS_MAIN_FILE_MODE = cfg?.isMainFileMode || false;

    this.db = new Database({
      onError: cfg?.onDbError || (() => undefined),
      adapter:
        cfg?.dbAdapter ||
        new IndexedDbAdapter({
          // TODO to variable
          dbName: 'pf',
          dbMainName: 'main',
          version: 1,
        }),
    });

    this.metaModel = new MetaModelCtrl(this.db, IS_MAIN_FILE_MODE);
    this.m = this._createModels(modelCfgs);
    pfLog(2, `m`, this.m);

    this.syncProviders = syncProviders;
    this.syncProviders.forEach((sp) => {
      sp.credentialsStore = new SyncProviderCredentialsStore<unknown>(this.db, sp.id);
    });

    this._syncService = new SyncService<MD>(
      IS_MAIN_FILE_MODE,
      this.m,
      this._activeSyncProvider$,
      this.metaModel,
      new EncryptAndCompressHandlerService(),
    );
  }

  // TODO type
  async sync(): Promise<{ status: SyncStatus; conflictData?: ConflictData }> {
    pfLog(3, `${this.sync.name}()`);
    const result = await this._syncService.sync();
    pfLog(2, `${this.sync.name}() result:`, result);
    return result;
  }

  setActiveSyncProvider(activeProviderId: SyncProviderId | null): void {
    pfLog(2, `${this.setActiveSyncProvider.name}()`, activeProviderId, activeProviderId);
    if (activeProviderId) {
      const provider = this.syncProviders.find((sp) => sp.id === activeProviderId);
      if (!provider) {
        throw new InvalidSyncProviderError();
      }
      this._activeSyncProvider$.next(provider);
      provider.isReady().then((isReady) => {
        this.isSyncProviderActiveAndReady$.next(isReady);
      });
    } else {
      this.isSyncProviderActiveAndReady$.next(false);
      this._activeSyncProvider$.next(null);
    }
  }

  getActiveSyncProvider(): SyncProviderServiceInterface<unknown> | null {
    return this._activeSyncProvider$.value;
  }

  // TODO typing
  async setCredentialsForActiveProvider(credentials: unknown): Promise<void> {
    pfLog(
      2,
      `${this.setCredentialsForActiveProvider.name}()`,
      credentials,
      this._activeSyncProvider$.value,
    );
    if (!this._activeSyncProvider$.value) {
      throw new NoSyncProviderSetError();
    }
    await this._activeSyncProvider$.value.setCredentials(credentials);
    this.isSyncProviderActiveAndReady$.next(
      await this._activeSyncProvider$.value.isReady(),
    );
  }

  async getAllSyncModelData(): Promise<AllSyncModels<MD>> {
    pfLog(2, `${this.getAllSyncModelData.name}()`);
    const modelIds = Object.keys(this.m);
    const promises = modelIds.map((modelId) => {
      const modelCtrl = this.m[modelId];
      return modelCtrl.load();
    });

    const allDataArr = await Promise.all(promises);
    const allData = allDataArr.reduce((acc, cur, idx) => {
      acc[modelIds[idx]] = cur;
      return acc;
    }, {});
    return allData as AllSyncModels<MD>;
  }

  async importAllSycModelData(
    data: AllSyncModels<MD>,
    crossModelVersion: number,
    isAttemptRepair = false,
  ): Promise<unknown> {
    pfLog(2, `${this.importAllSycModelData.name}()`, { data, cfg: this._cfg });
    if (this._cfg?.validate && !this._cfg.validate(data)) {
      if (isAttemptRepair && this._cfg.repair) {
        data = this._cfg.repair(data);
      }
      throw new DataValidationFailedError();
    }
    const modelIds = Object.keys(data);
    const promises = modelIds.map((modelId) => {
      const modelData = data[modelId];
      const modelCtrl = this.m[modelId];
      if (!modelCtrl) {
        throw new ModelIdWithoutCtrlError(modelId, modelData);
      }

      return modelCtrl.save(modelData, { isUpdateRevAndLastUpdate: false });
    });
    return Promise.all(promises);
  }

  downloadAll(isSkipLockFileCheck: boolean = false): Promise<void> {
    pfLog(2, `${this.downloadAll.name}()`, { isSkipLockFileCheck });
    return this._syncService.downloadAll(isSkipLockFileCheck);
  }

  uploadAll(isSkipLockFileCheck: boolean = false): Promise<void> {
    pfLog(2, `${this.uploadAll.name}()`, { isSkipLockFileCheck });
    return this._syncService.uploadAll(isSkipLockFileCheck);
  }

  // public on<K extends keyof EventMap>(
  //   eventName: K,
  //   callback: (data: EventMap[K]) => void,
  // ): () => void {
  //   // Implement event handling
  //   const eventId = Symbol();
  //   this._eventHandlers.set(eventName, {
  //     ...(this._eventHandlers.get(eventName) || {}),
  //     [eventId]: callback,
  //   });
  //
  //   // Return unsubscribe function
  //   return () => {
  //     const handlers = this._eventHandlers.get(eventName);
  //     if (handlers) {
  //       delete handlers[eventId];
  //     }
  //   };
  // }

  isValidateComplete(data: AllSyncModels<MD>): boolean {
    pfLog(2, `${this.isValidateComplete.name}()`, { data });
    if (!this._cfg?.validate) {
      throw new NoValidateFunctionProvidedError();
    }
    if (!this._cfg.validate(data)) {
      throw new DataValidationFailedError();
    }
    return true;
  }

  repairCompleteData(data: unknown): AllSyncModels<MD> {
    pfLog(2, `${this.repairCompleteData.name}()`, { data });
    if (!this._cfg?.repair) {
      throw new NoRepairFunctionProvidedError();
    }
    return this._cfg.repair(data);
  }

  async clearDatabaseExceptLocalOnly(): Promise<void> {
    pfLog(2, `${this.clearDatabaseExceptLocalOnly.name}()`);

    const MODELS_TO_PRESERVE: string[] = [
      MetaModelCtrl.META_MODEL_ID,
      MetaModelCtrl.CLIENT_ID,
      // NOTE prefixes also work
      SyncProviderCredentialsStore.DB_KEY_PREFIX,
    ];
    const localOnlyModels = Object.keys(this.m).filter(
      (modelId) => this.m[modelId].modelCfg.isLocalOnly,
    );
    const allModelsToPreserve = [...MODELS_TO_PRESERVE, ...localOnlyModels];
    console.log({ allModelsToPreserve });

    const model = this.db.loadAll();
    const keysToDelete = Object.keys(model).filter(
      (key) => !allModelsToPreserve.includes(key),
    );
    const promises = keysToDelete.map((key) => this.db.remove(key));
    await Promise.all(promises);
  }

  private _createModels(modelCfgs: MD): ModelCfgToModelCtrl<MD> {
    const result = {} as Record<string, ModelCtrl<ModelBase>>;
    // TODO validate modelCfgs
    for (const [id, item] of Object.entries(modelCfgs)) {
      if (!item.modelVersion) {
        throw new InvalidModelCfgError({ modelCfgs });
      }
      result[id] = new ModelCtrl<ExtractModelCfgType<typeof item>>(
        id,
        item,
        this.db,
        this.metaModel,
      );
    }
    return result as ModelCfgToModelCtrl<MD>;
  }

  // getAllModelData(): unknown {}

  // /**
  //  * Updates configuration and propagates changes
  //  * @param cfg Updated configuration
  //  */
  // // TODO think about this
  // public updateCfg(cfg: Partial<BaseCfg>): void {
  //   const currentCfg = this._cfg$.value;
  //   const newCfg = { ...currentCfg, ...cfg };
  //   this._cfg$.next(newCfg);
  // }
}

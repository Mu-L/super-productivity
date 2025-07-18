import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { hideNonTaskSidePanelContent } from './layout.actions';
import { filter, mapTo } from 'rxjs/operators';
import { setSelectedTask } from '../../../features/tasks/store/task.actions';
import { LayoutService } from '../layout.service';
import { NavigationEnd, Router } from '@angular/router';

// what should happen
// task selected => open panel
// note show => open panel
// task selected, note show => task unselected, note shown
// note show, task selected, note show => task unselected, note shown
// note show, task selected => task shown, note hidden
// task selected, note show, task selected => task shown, note hidden

@Injectable()
export class LayoutEffects {
  private actions$ = inject(Actions);
  private layoutService = inject(LayoutService);
  private router = inject(Router);

  hideNotesWhenTaskIsSelected$ = createEffect(() =>
    this.actions$.pipe(
      ofType(setSelectedTask),
      filter(({ id }) => id !== null),
      mapTo(hideNonTaskSidePanelContent()),
    ),
  );

  hideNotesNavigatingToDailySummary$ = createEffect(() =>
    this.router.events.pipe(
      filter((event: any) => event instanceof NavigationEnd),
      filter((event) => !!event.url.match(/(daily-summary)$/)),
      mapTo(hideNonTaskSidePanelContent()),
    ),
  );
}

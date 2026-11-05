/** Installed before anything else in the owner process, so timers started at import time are labelled. */
import {installOwnerTaskLabels} from './owner-task-labels';
installOwnerTaskLabels();

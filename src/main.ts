import * as core from '@actions/core'
import {updateProjectStatus} from './update-project-status'

updateProjectStatus()
  .catch(err => {
    core.setFailed(err.message)
    process.exit(1)
  })
  .then(() => {
    process.exit(0)
  })
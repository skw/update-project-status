import * as core from '@actions/core'
import * as github from '@actions/github'

// TODO: Ensure this (and the Octokit client) works for non-github.com URLs, as well.
// https://github.com/orgs|users/<ownerName>/projects/<projectNumber>
const urlParse =
  /^(?:https:\/\/)?github\.com\/(?<ownerType>orgs|users)\/(?<ownerName>[^/]+)\/projects\/(?<projectNumber>\d+)/

interface ProjectNextFieldValue {
  id: string
  value: string
  projectField: {
    name: string
  }
}

interface ProjectNextField {
  id: string
  name: string
  settings: string
}

interface ProjectNextItem {
  id: string
  title: string
  content:
    | {
        nodes: {
          name: string
        }[]
      }
    | Record<string, never>
  fieldValues: {
    nodes: ProjectNextFieldValue[]
  }
}

interface ProjectNodeIDResponse {
  organization?: {
    projectNext: {
      id: string
      fields: {
        nodes: ProjectNextField[]
      }
      items: {
        nodes: ProjectNextItem[]
        totalCount: number
      }
    }
  }

  user?: {
    projectNext: {
      id: string
      fields: {
        nodes: ProjectNextField[]
      }
      items: {
        nodes: ProjectNextItem[]
        totalCount: number
      }
    }
  }
}

interface UpdateProjectNextItemFieldResponse {
  updateProjectNextItemField: {
    projectNextItem: {
      id: string
    }
  }
}

export async function updateProjectStatus(): Promise<void> {
  const projectUrl = core.getInput('project-url', {required: true})
  const ghToken = core.getInput('github-token', {required: true})
  const labeled =
    core
      .getInput('labeled')
      .split(',')
      .map(l => l.trim())
      .filter(l => l.length > 0) ?? []
  const status = core.getInput('status', {required: true}).trim()
  const octokit = github.getOctokit(ghToken)
  const urlMatch = projectUrl.match(urlParse)

  core.debug(`Project URL: ${projectUrl}`)

  if (!urlMatch) {
    throw new Error(
      `Invalid project URL: ${projectUrl}. Project URL should match the format https://github.com/<orgs-or-users>/<ownerName>/projects/<projectNumber>`
    )
  }

  const ownerName = urlMatch.groups?.ownerName
  const projectNumber = parseInt(urlMatch.groups?.projectNumber ?? '', 10)
  const ownerType = urlMatch.groups?.ownerType
  const ownerTypeQuery = mustGetOwnerTypeQuery(ownerType)

  core.debug(`Org name: ${ownerName}`)
  core.debug(`Project number: ${projectNumber}`)
  core.debug(`Owner type: ${ownerType}`)
  core.debug(`labeled: ${JSON.stringify(labeled)}`)

  // Get memex project id and items
  const idResp = await octokit.graphql<ProjectNodeIDResponse>(
    `query getProject($ownerName: String!, $projectNumber: Int!) { 
      ${ownerTypeQuery}(login: $ownerName) {
        projectNext(number: $projectNumber) {
          id
          fields(first: 50) {
            nodes {
              id
              name
              settings
            }
          }
          items(first: 100) {
            nodes {
              id
              content {
                ... on Issue {
                  labels(first: 50) {
                    nodes {
                      name
                    }
                  }

                }
              }
              fieldValues(first: 50) {
                nodes {
                  id
                  value
                  projectField {
                    name
                  }
                }
                totalCount
              }
            }
            totalCount
          }
        }
      }
    }`,
    {
      ownerName,
      projectNumber
    }
  )

  const projectId = idResp[ownerTypeQuery]?.projectNext.id
  const projectItemCount = idResp[ownerTypeQuery]?.projectNext.items.totalCount
  const projectItems = idResp[ownerTypeQuery]?.projectNext.items.nodes
  const statusField = idResp[ownerTypeQuery]?.projectNext.fields.nodes.find(field => field.name === 'Status')
  const selectedStatusSetting: {id: string; name: string} | undefined = statusField
    ? JSON.parse(statusField.settings)?.options.find((o: {id: string; name: string}) => o.name === status)
    : undefined

  if (!selectedStatusSetting || !statusField) {
    throw new Error(`The selected status "${status}" could not be found for ${projectUrl}`)
  }

  const itemsToUpdate = projectItems
    ? projectItemsToUpdate({selectedStatusId: selectedStatusSetting.id, projectItems, labeled})
    : []

  core.debug(`Project node ID: ${projectId}`)
  core.debug(`Project item count: ${projectItemCount}`)
  core.debug(`Project itemsToUpdate: ${JSON.stringify(itemsToUpdate)}`)
  core.debug(`selectedStatusSetting: ${JSON.stringify(selectedStatusSetting)}`)

  if (itemsToUpdate.length > 0) {
    core.debug(`${itemsToUpdate.length} item(s) selected for status update`)
  } else {
    core.debug(`No items selected for status update`)
    return
  }

  for (const itemToUpdate of itemsToUpdate) {
    await octokit.graphql<UpdateProjectNextItemFieldResponse>(
      `mutation updateProjectNextItemField($input: UpdateProjectNextItemFieldInput!) {
        updateProjectNextItemField(input: $input) {
          projectNextItem {
            id
          }
        }
      }`,
      {
        input: {
          projectId,
          itemId: itemToUpdate.id,
          fieldId: statusField.id,
          value: selectedStatusSetting.id
        }
      }
    )

    core.debug(`${itemToUpdate.id} set to ${selectedStatusSetting.name}`)
  }
}

export function mustGetOwnerTypeQuery(ownerType?: string): 'organization' | 'user' {
  const ownerTypeQuery = ownerType === 'orgs' ? 'organization' : ownerType === 'users' ? 'user' : null

  if (!ownerTypeQuery) {
    throw new Error(`Unsupported ownerType: ${ownerType}. Must be one of 'orgs' or 'users'`)
  }

  return ownerTypeQuery
}

function projectItemsToUpdate({
  projectItems,
  selectedStatusId,
  labeled
}: {
  projectItems: ProjectNextItem[]
  selectedStatusId: string
  labeled: string[]
}) {
  const formattedData = []

  for (const projectItem of projectItems) {
    const statusFieldValue = projectItem.fieldValues.nodes.find(fieldValue => fieldValue.projectField.name === 'Status')
    const labels = projectItem.content ? projectItem.content?.nodes?.map(l => l.name) : []
    const includesLabel = labeled.length > 0 && labels.length > 0 ? labels.some(l => labeled.includes(l)) : true

    if (includesLabel && statusFieldValue && statusFieldValue?.value !== selectedStatusId) {
      formattedData.push({
        id: projectItem.id,
        statusValue: statusFieldValue?.value
      })
    }
  }

  return formattedData
}

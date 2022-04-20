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
    id: string
    name: string
  }
}

interface ProjectNextItem {
  id: string
  title: string
  fieldValues: {
    nodes: ProjectNextFieldValue[]
  }
}

interface ProjectNodeIDResponse {
  organization?: {
    projectNext: {
      id: string
      items: {
        nodes: ProjectNextItem[]
        totalCount: number
      }
    }
  }

  user?: {
    projectNext: {
      id: string
      items: {
        nodes: ProjectNextItem[]
        totalCount: number
      }
    }
  }
}

export async function updateProjectStatus(): Promise<void> {
  const projectUrl = core.getInput('project-url', {required: true})
  const ghToken = core.getInput('github-token', {required: true})

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

  // First, use the GraphQL API to request the project's node ID.
  const idResp = await octokit.graphql<ProjectNodeIDResponse>(
    `query getProject($ownerName: String!, $projectNumber: Int!) { 
      ${ownerTypeQuery}(login: $ownerName) {
        projectNext(number: $projectNumber) {
          id
          items(first: 100) {
            nodes {
              id
              fieldValues(first: 50) {
                nodes {
                  id
                  value
                  projectField {
                    id
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
  const formatted = projectItems ? formatProjectItemData(projectItems) : []

  core.debug(`Project node ID: ${projectId}`)
  core.debug(`Project item count: ${projectItemCount}`)
  core.debug(`Project item IDs: ${JSON.stringify(formatted)}`)
}

export function mustGetOwnerTypeQuery(ownerType?: string): 'organization' | 'user' {
  const ownerTypeQuery = ownerType === 'orgs' ? 'organization' : ownerType === 'users' ? 'user' : null

  if (!ownerTypeQuery) {
    throw new Error(`Unsupported ownerType: ${ownerType}. Must be one of 'orgs' or 'users'`)
  }

  return ownerTypeQuery
}

function formatProjectItemData(projectItems: ProjectNextItem[]) {
  const formattedData = []

  for (const projectItem of projectItems) {
    const statusFieldValue = projectItem.fieldValues.nodes.find(fieldValue => fieldValue.projectField.name === 'Status')

    if (statusFieldValue) {
      formattedData.push({
        id: projectItem.id,
        status: statusFieldValue?.projectField.id
      })
    }
  }

  return formattedData
}

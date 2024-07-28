import {MinimalOrganizationApp, OrganizationApp} from '../../models/organization.js'
import {selectAppPrompt} from '../../prompts/dev.js'
import {Flag} from '../../utilities/developer-platform-client.js'
import {ExtensionSpecification} from '../../models/extensions/specification.js'
import {AppConfigurationUsedByCli} from '../../models/extensions/specifications/types/app_config.js'
import {
  AppModuleVersion,
  DeveloperPlatformClient,
  selectDeveloperPlatformClient,
} from '../../utilities/developer-platform-client.js'
import {selectOrg} from '../context.js'
import {searchForAppsByNameFactory} from '../dev/prompt-helpers.js'
import {deepMergeObjects} from '@shopify/cli-kit/common/object'

export async function selectApp(): Promise<OrganizationApp> {
  const org = await selectOrg()
  const developerPlatformClient = selectDeveloperPlatformClient({organization: org})
  const {apps, hasMorePages} = await developerPlatformClient.appsForOrg(org.id)
  const selectedApp = await selectAppPrompt(
    searchForAppsByNameFactory(developerPlatformClient, org.id),
    apps,
    hasMorePages,
  )
  const fullSelectedApp = await developerPlatformClient.appFromId(selectedApp)
  return fullSelectedApp!
}

export function extensionTypeStrategy(specs: ExtensionSpecification[], type?: string) {
  if (!type) return
  const spec = specs.find(
    (spec) =>
      spec.identifier === type || spec.externalIdentifier === type || spec.additionalIdentifiers?.includes(type),
  )
  return spec?.uidStrategy
}

/**
 * Given an app from the platform, return a top-level app configuration object to use locally.
 *
 * The current active app version is used as the source for configuration.
 *
 * @returns - a top-level app configuration object, or undefined if there's no active app version to use.
 */
export async function fetchAppRemoteConfiguration(
  remoteApp: MinimalOrganizationApp,
  developerPlatformClient: DeveloperPlatformClient,
  specifications: ExtensionSpecification[],
  flags: Flag[],
) {
  const activeAppVersion = await developerPlatformClient.activeAppVersion(remoteApp)
  const appModuleVersionsConfig =
    activeAppVersion?.appModuleVersions.filter(
      (module) => extensionTypeStrategy(specifications, module.specification?.identifier) !== 'uuid',
    ) || []

  // This might be droppable -- if remote apps always have an active version and some modules?
  if (appModuleVersionsConfig.length === 0) return undefined

  const remoteConfiguration = remoteAppConfigurationExtensionContent(
    appModuleVersionsConfig,
    specifications,
    flags,
  ) as unknown as AppConfigurationUsedByCli
  return remoteConfiguration
}

/**
 * Given a set of modules provided by the platform, return a top-level app configuration object to use locally.
 *
 * Some modules may have transformations configured, provided by the module's specification. The configurations,
 * transformed or not, are merged together into a single object.
 *
 * @param configRegistrations - modules provided by the platform. The caller is expected to filter to those relevant to top-level app configuration.
 * @returns a top-level app configuration object
 */
export function remoteAppConfigurationExtensionContent(
  configRegistrations: AppModuleVersion[],
  specifications: ExtensionSpecification[],
  flags: Flag[],
) {
  let remoteAppConfig: {[key: string]: unknown} = {}
  const configSpecifications = specifications.filter((spec) => spec.uidStrategy !== 'uuid')
  configRegistrations.forEach((module) => {
    const configSpec = configSpecifications.find(
      (spec) => spec.identifier === module.specification?.identifier.toLowerCase(),
    )
    if (!configSpec) return
    const config = module.config
    if (!config) return

    remoteAppConfig = deepMergeObjects(remoteAppConfig, configSpec.transformRemoteToLocal?.(config, {flags}) ?? config)
  })

  return {...remoteAppConfig}
}

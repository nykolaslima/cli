import {createUIExtensionSpecification} from '../ui.js'
import {BaseFunctionConfigurationSchema} from '../schemas.js'
import {defaultFunctionsFlavors} from '../../../constants.js'
import {ExtensionCategory} from '../../app/extensions.js'

const spec = createUIExtensionSpecification({
  identifier: 'function',
  additionalIdentifiers: [
    'order_discounts',
    'cart_checkout_validation',
    'cart_transform',
    'delivery_customization',
    'payment_customization',
    'product_discounts',
    'shipping_discounts',
    'fulfillment_constraints',
  ],
  surface: 'admin',
  schema: BaseFunctionConfigurationSchema,
  supportedFlavors: defaultFunctionsFlavors,
  partnersWebIdentifier: 'theme_app_extension',
  graphQLType: 'function',
  category: (): ExtensionCategory => 'function',
})

export default spec

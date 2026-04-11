import { getGravatarUrl } from './gravatarHelper.js';

/**
 * Email signature templates and helpers for professional email signatures
 */

/**
 * Generate a professional HTML email signature
 * @param {Object} options - Signature configuration options
 * @returns {string} HTML signature
 */
export function generateProfessionalSignature(options) {
  const {
    name,
    title,
    email,
    avatarUrl,
    organization,
    phone,
    website,
    socialLinks = {},
    disclaimer,
    style = 'modern', // modern, classic, minimal
    role,
    department
  } = options;

  // Determine the template based on role or department
  const template = selectTemplateByRoleOrDepartment(role, department, style);

  // Use Gravatar if no custom avatar URL provided
  const imageUrl = avatarUrl || getGravatarUrl(email, 100, 'robohash');

  switch (template) {
    case 'minimal':
      return generateMinimalSignature({ name, title, email, imageUrl });
    
    case 'classic':
      return generateClassicSignature({ name, title, email, imageUrl, organization, phone, website, disclaimer });
    
    case 'modern':
    default:
      return generateModernSignature({ name, title, email, imageUrl, organization, phone, website, socialLinks, disclaimer });
  }
}

/**
 * Select signature template based on user role or department
 * @param {string} role - User role
 * @param {string} department - User department
 * @param {string} defaultStyle - Default style if no specific template is found
 * @returns {string} Selected template style
 */
function selectTemplateByRoleOrDepartment(role, department, defaultStyle) {
  const roleBasedTemplates = {
    'manager': 'classic',
    'developer': 'modern',
    'intern': 'minimal'
  };

  const departmentBasedTemplates = {
    'sales': 'classic',
    'engineering': 'modern',
    'hr': 'minimal'
  };

  if (role && roleBasedTemplates[role.toLowerCase()]) {
    return roleBasedTemplates[role.toLowerCase()];
  }

  if (department && departmentBasedTemplates[department.toLowerCase()]) {
    return departmentBasedTemplates[department.toLowerCase()];
  }

  return defaultStyle;
}

/**
 * Modern signature with avatar and social links
 */
function generateModernSignature(opts) {
  const { name, title, email, imageUrl, organization, phone, website, socialLinks, disclaimer } = opts;
  
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="font-family: Arial, sans-serif; color: #333; max-width: 600px;">
      <tr>
        <td style="border-top: 3px solid #0066cc; padding-top: 20px;"></td>
      </tr>
      <tr>
        <td>
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right: 20px; vertical-align: top;">
                <img src="${imageUrl}" alt="${name}" style="width: 90px; height: 90px; border-radius: 50%; display: block; border: 3px solid #f0f0f0;">
              </td>
              <td style="vertical-align: top; padding-top: 5px;">
                <h3 style="margin: 0; font-size: 18px; color: #0066cc; font-weight: 600;">${name}</h3>
                <p style="margin: 5px 0; font-size: 14px; color: #666;">${title}</p>
                ${organization ? `<p style="margin: 5px 0; font-size: 14px; color: #666;">${organization}</p>` : ''}
                
                <table cellpadding="0" cellspacing="0" border="0" style="margin-top: 10px;">
                  <tr>
                    <td style="padding-right: 10px;">
                      <a href="mailto:${email}" style="color: #0066cc; text-decoration: none; font-size: 13px;">
                        📧 ${email}
                      </a>
                    </td>
                  </tr>
                  ${phone ? `
                  <tr>
                    <td style="padding-right: 10px; padding-top: 5px;">
                      <a href="tel:${phone}" style="color: #666; text-decoration: none; font-size: 13px;">
                        📱 ${phone}
                      </a>
                    </td>
                  </tr>` : ''}
                  ${website ? `
                  <tr>
                    <td style="padding-right: 10px; padding-top: 5px;">
                      <a href="${website}" style="color: #666; text-decoration: none; font-size: 13px;">
                        🌐 ${website.replace(/^https?:\/\//, '')}
                      </a>
                    </td>
                  </tr>` : ''}
                </table>
                
                ${Object.keys(socialLinks).length > 0 ? generateSocialLinks(socialLinks) : ''}
              </td>
            </tr>
          </table>
        </td>
      </tr>
      ${disclaimer ? `
      <tr>
        <td style="padding-top: 15px;">
          <p style="margin: 0; font-size: 11px; color: #999; font-style: italic; border-top: 1px solid #e0e0e0; padding-top: 15px;">
            ${disclaimer}
          </p>
        </td>
      </tr>` : ''}
    </table>
  `;
}

/**
 * Classic professional signature
 */
function generateClassicSignature(opts) {
  const { name, title, email, imageUrl, organization, phone, website, disclaimer } = opts;
  
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="font-family: Georgia, serif;">
      <tr>
        <td style="border-top: 2px solid #333; padding-top: 15px;"></td>
      </tr>
      <tr>
        <td>
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right: 15px; vertical-align: middle;">
                <img src="${imageUrl}" alt="${name}" style="width: 70px; height: 70px; border-radius: 5px; display: block;">
              </td>
              <td style="vertical-align: middle; border-left: 2px solid #ccc; padding-left: 15px;">
                <p style="margin: 0; font-size: 16px; font-weight: bold; color: #333;">${name}</p>
                <p style="margin: 3px 0; font-size: 14px; color: #666;">${title}</p>
                ${organization ? `<p style="margin: 3px 0; font-size: 14px; color: #666;">${organization}</p>` : ''}
                <p style="margin: 8px 0 0 0; font-size: 13px;">
                  <a href="mailto:${email}" style="color: #333;">${email}</a>
                  ${phone ? ` | ${phone}` : ''}
                  ${website ? ` | <a href="${website}" style="color: #333;">${website.replace(/^https?:\/\//, '')}</a>` : ''}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      ${disclaimer ? `
      <tr>
        <td style="padding-top: 10px;">
          <p style="margin: 0; font-size: 10px; color: #999; font-style: italic;">
            ${disclaimer}
          </p>
        </td>
      </tr>` : ''}
    </table>
  `;
}

/**
 * Minimal signature
 */
function generateMinimalSignature(opts) {
  const { name, title, email, imageUrl } = opts;
  
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">
      <tr>
        <td style="padding-top: 20px;">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-right: 12px;">
                <img src="${imageUrl}" alt="${name}" style="width: 48px; height: 48px; border-radius: 24px; display: block;">
              </td>
              <td>
                <p style="margin: 0; font-size: 14px; font-weight: 500; color: #333;">${name}</p>
                <p style="margin: 2px 0 0 0; font-size: 13px; color: #666;">
                  ${title} • <a href="mailto:${email}" style="color: #0066cc; text-decoration: none;">${email}</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Generate social media links
 */
function generateSocialLinks(links) {
  const iconMap = {
    linkedin: '🔗',
    twitter: '𝕏',
    github: '💻',
    facebook: '📘',
    instagram: '📷'
  };

  const linkElements = Object.entries(links)
    .filter(([platform, url]) => url)
    .map(([platform, url]) => {
      const icon = iconMap[platform] || '🔗';
      return `<a href="${url}" style="color: #666; text-decoration: none; font-size: 16px; margin-right: 8px;">${icon}</a>`;
    })
    .join('');

  return linkElements ? `
    <table cellpadding="0" cellspacing="0" border="0" style="margin-top: 10px;">
      <tr>
        <td>${linkElements}</td>
      </tr>
    </table>
  ` : '';
}

/**
 * Settings helper for email signature configuration
 */
export const signatureStyles = {
  modern: {
    name: 'Modern',
    description: 'Contemporary design with avatar and social links'
  },
  classic: {
    name: 'Classic',
    description: 'Traditional professional layout'
  },
  minimal: {
    name: 'Minimal',
    description: 'Simple and clean design'
  }
};
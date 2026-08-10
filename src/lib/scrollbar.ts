/**
 * The subtle-scrollbar class.
 *
 * This was an `sx` fragment spread into half a dozen scrollable panes. Primer 38 has no `sx`, and
 * the rules are `::-webkit-scrollbar` pseudo-elements besides — which never belonged in an inline
 * style object, because a pseudo-element cannot be expressed as one at all. It is a class now, and
 * the call sites compose it alongside their own.
 */

import styles from './scrollbar.module.css';

export const subtleScrollbar = styles.subtleScrollbar;

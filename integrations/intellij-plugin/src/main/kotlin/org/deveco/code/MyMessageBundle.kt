package org.deveco.code

import com.intellij.DynamicBundle

private const val BUNDLE = "messages.MyMessageBundle"

object MyMessageBundle {

    private val instance = DynamicBundle(MyMessageBundle::class.java, BUNDLE)

    fun message(key: String, vararg params: Any?): String = instance.getMessage(key, *params)
}
